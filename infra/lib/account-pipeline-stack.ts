import * as path from "path";
import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dsql from "aws-cdk-lib/aws-dsql";

// ADR-0002: maxReceiveCount is kept low. The two-stage retry (in-Lambda retry_on_occ,
// then SQS-level redelivery) means only failures that survive 3 in-process OCC retries
// ever reach SQS, so a long SQS-level retry budget isn't needed.
const MAX_RECEIVE_COUNT = 3;

// DSQL runtime connections must use a non-admin custom role (dsql:DbConnect), not the
// admin role (dsql:DbConnectAdmin, reserved for schema setup). See apply-schema.sh.
const APP_DB_ROLE = "account_service_app";

export class AccountPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Aurora DSQL cluster -------------------------------------------------
    // No L2 construct exists yet for DSQL (aws/aws-cdk#34593), so this uses the L1
    // CfnCluster directly. Single-Region cluster; deletion protection is off because
    // this is a PoC stack that needs to be torn down freely, not a production cluster.
    const cluster = new dsql.CfnCluster(this, "AccountCluster", {
      deletionProtectionEnabled: false,
      tags: [{ key: "Project", value: "moneta-poc" }],
    });

    // --- SQS FIFO queue + DLQ -------------------------------------------------
    const deadLetterQueue = new sqs.Queue(this, "AccountCommandDlq", {
      queueName: "moneta-account-commands.fifo",
      fifo: true,
    });

    const commandQueue = new sqs.Queue(this, "AccountCommandQueue", {
      queueName: "moneta-account-commands-main.fifo",
      fifo: true,
      // Producers (currently: manual `aws sqs send-message` for this milestone,
      // API Gateway in a later milestone) set MessageDeduplicationId explicitly.
      contentBasedDeduplication: false,
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: MAX_RECEIVE_COUNT,
      },
    });

    // --- Lambda (Rust, account-service) --------------------------------------
    // Cross-compiled inside the official AWS Lambda provided.al2023 build image via
    // Docker bundling, since cargo-lambda/zig aren't installed locally but Docker is.
    // The whole Cargo workspace root is passed as the asset so Cargo.lock and both
    // workspace members (account-domain, account-service) are visible to the build.
    const repoRoot = path.join(__dirname, "..", "..");

    // x86_64 (not ARM_64): the SAM provided.al2023 build image only ships a native
    // x86_64 gcc, and this host is x86_64, so building for the same triple avoids
    // needing an aarch64 cross-linker set up just for this PoC.
    const fn = new lambda.Function(this, "AccountServiceFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromAsset(repoRoot, {
        bundling: {
          image: lambda.Runtime.PROVIDED_AL2023.bundlingImage,
          user: "root",
          command: [
            "bash",
            "-c",
            [
              "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable",
              ". $HOME/.cargo/env",
              "cargo build --release --target x86_64-unknown-linux-gnu -p account-service",
              "cp target/x86_64-unknown-linux-gnu/release/account-service /asset-output/bootstrap",
            ].join(" && "),
          ],
        },
      }),
      environment: {
        // No password: aurora-dsql-sqlx-connector generates and injects a short-lived
        // IAM auth token per connection using the Lambda execution role's credentials.
        DATABASE_URL: `postgres://${APP_DB_ROLE}@${cluster.attrEndpoint}:5432/postgres?sslmode=require`,
      },
    });

    fn.addEventSource(
      new SqsEventSource(commandQueue, {
        batchSize: 10, // FIFO queue maximum
        reportBatchItemFailures: true,
        // maxBatchingWindow is intentionally not set: unsupported for FIFO source queues.
      }),
    );

    // --- IAM: DSQL DbConnect (non-admin) for the Lambda execution role --------
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dsql:DbConnect"],
        resources: [cluster.attrResourceArn],
      }),
    );

    // --- Outputs ---------------------------------------------------------------
    new cdk.CfnOutput(this, "ClusterEndpoint", { value: cluster.attrEndpoint });
    new cdk.CfnOutput(this, "ClusterResourceArn", { value: cluster.attrResourceArn });
    new cdk.CfnOutput(this, "CommandQueueUrl", { value: commandQueue.queueUrl });
    new cdk.CfnOutput(this, "DeadLetterQueueUrl", { value: deadLetterQueue.queueUrl });
    new cdk.CfnOutput(this, "AccountServiceFunctionName", { value: fn.functionName });
    new cdk.CfnOutput(this, "LambdaExecutionRoleArn", { value: fn.role!.roleArn });
  }
}

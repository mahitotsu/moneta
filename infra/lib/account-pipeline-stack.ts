import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dsql from "aws-cdk-lib/aws-dsql";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as eventschemas from "aws-cdk-lib/aws-eventschemas";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sqs from "aws-cdk-lib/aws-sqs";

// ADR-0002: maxReceiveCount is kept low. The two-stage retry (in-Lambda retry_on_occ,
// then SQS-level redelivery) means only failures that survive 3 in-process OCC retries
// ever reach SQS, so a long SQS-level retry budget isn't needed.
const MAX_RECEIVE_COUNT = 3;

// DSQL runtime connections must use a non-admin custom role (dsql:DbConnect), not the
// admin role (dsql:DbConnectAdmin, reserved for schema setup). See apply-schema.sh.
const APP_DB_ROLE = "account_service_app";

// EventBridge (docs/adr/0004): account-serviceが発行するドメインイベントスキーマの契約名。
const EVENT_SOURCE = "account-service";
const EVENT_SCHEMA_REGISTRY_NAME = "moneta-account-service";
const EVENT_SCHEMA_NAME = `${EVENT_SOURCE}@AccountDomainEvent`;

// account-domain::Eventの全バリアントに対応するDetailType(account-service/src/outbox.rsの
// to_outbox_entryが生成する形式と一致させる)。rejection(却下)はここに含めない——却下は
// viewを変化させないため、Query Serviceは購読しない。
const ACCOUNT_EVENT_DETAIL_TYPES = [
  "Opened",
  "Deposited",
  "Withdrawn",
  "Frozen",
  "Unfrozen",
  "Closed",
].map((variant) => `account.event.${variant}`);

export class AccountPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Rust製3バイナリ(account-service, account-outbox-relay, account-query-projector)は
    // 全て同じワークスペースルート・同じ手順でビルドするため、バイナリ名だけを差し替えられる
    // ヘルパーに切り出して重複を避ける。
    //
    // このビルドは(ホストもLambdaターゲットもx86_64なので)CPUアーキテクチャの変換ではなく、
    // glibcバージョンの互換性のために必要——このリポジトリの開発ホストはLambdaのprovided.al2023
    // ランタイムより新しいglibcを積んでおり、ホスト上で直接ビルドしたバイナリはLambda上で
    // 実行時リンクエラーになる。そのためAWS公式のSAMビルドイメージ(Lambdaランタイムと同じglibc)
    // の中でビルドする。
    //
    // rustupのインストール・依存クレートのダウンロード・コンパイル成果物は、バイナリ間は
    // もちろん`cdk synth`の実行間でもリポジトリ内のキャッシュディレクトリへ永続化し、
    // Dockerコンテナへボリュームマウントすることで毎回ゼロからやり直さないようにする
    // (キャッシュがない状態からのビルドはバイナリ1つあたり数分かかるが、依存関係が変わらない
    // 限り2回目以降はほぼ瞬時に終わる)。
    const repoRoot = path.join(__dirname, "..", "..");
    const dockerCacheRoot = path.join(repoRoot, ".rust-lambda-docker-cache");
    const cargoHomeCache = path.join(dockerCacheRoot, "cargo-home");
    // rustupの実体(ツールチェイン本体)は$CARGO_HOMEではなく$RUSTUP_HOMEに入る。$CARGO_HOME/bin
    // にはツールチェイン切り替え用のプロキシしかなく、これだけキャッシュしても「defaultの
    // ツールチェインが見つからない」エラーになるため、両方を揃えてキャッシュする。
    const rustupHomeCache = path.join(dockerCacheRoot, "rustup-home");
    const targetDirCache = path.join(dockerCacheRoot, "target");
    for (const dir of [cargoHomeCache, rustupHomeCache, targetDirCache]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const rustLambdaCode = (binaryName: string): lambda.Code =>
      lambda.Code.fromAsset(repoRoot, {
        // キャッシュディレクトリ自体はrepoRoot配下(discoverable/削除しやすい場所)に置くが、
        // アセットのソースには含めない。含めてしまうとCDKがLambdaアセットの内容ハッシュを
        // 計算する際にキャッシュ内の全ファイルを読もうとし、コンテナ内でroot権限で作成された
        // ファイル(ホスト側ではroot所有になる)の読み取りに失敗してEACCESで落ちる。
        exclude: [".rust-lambda-docker-cache"],
        bundling: {
          image: lambda.Runtime.PROVIDED_AL2023.bundlingImage,
          user: "root",
          volumes: [
            { hostPath: cargoHomeCache, containerPath: "/cargo-home" },
            { hostPath: rustupHomeCache, containerPath: "/rustup-home" },
            { hostPath: targetDirCache, containerPath: "/asset-input/target" },
          ],
          command: [
            "bash",
            "-c",
            [
              "export CARGO_HOME=/cargo-home RUSTUP_HOME=/rustup-home",
              // 初回のみrustupをインストールする(キャッシュ済みならスキップ)。
              '[ -x "$CARGO_HOME/bin/cargo" ] || curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable',
              '. "$CARGO_HOME/env"',
              `cargo build --release --target x86_64-unknown-linux-gnu -p account-service --bin ${binaryName}`,
              `cp target/x86_64-unknown-linux-gnu/release/${binaryName} /asset-output/bootstrap`,
              // このコンテナはrootで動くため、キャッシュ用ボリューム(ホスト側の
              // .rust-lambda-docker-cache)に書き込まれるファイルは何もしなければホスト側で
              // root所有になり、ホストのユーザーが削除・再利用できなくなる。/asset-inputは
              // ホスト側のステージングコピーなのでホストユーザー所有——それを基準に所有権を
              // 揃える(失敗してもビルド自体は既に成功しているのでbuildを失敗させない)。
              "chown -R --reference=/asset-input/Cargo.toml /cargo-home /rustup-home /asset-input/target || true",
            ].join(" && "),
          ],
        },
      });

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

    // --- Lambda (Rust, account-service: 書き込み経路) -------------------------
    // Cross-compiled inside the official AWS Lambda provided.al2023 build image via
    // Docker bundling, since cargo-lambda/zig aren't installed locally but Docker is.
    // The whole Cargo workspace root is passed as the asset so Cargo.lock and both
    // workspace members (account-domain, account-service) are visible to the build.
    //
    // x86_64 (not ARM_64): the SAM provided.al2023 build image only ships a native
    // x86_64 gcc, and this host is x86_64, so building for the same triple avoids
    // needing an aarch64 cross-linker set up just for this PoC.
    const fn = new lambda.Function(this, "AccountServiceFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("account-service"),
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

    // ==========================================================================
    // Query service (docs/adr/0004) — ADR-0001のイベント駆動連携の実証。
    //
    // サービス境界とOwnership: 「誰がViewスキーマにwillを持つか」から辿り、Rule・Projector・
    // DynamoDB・照会APIはすべてQuery Service側の所有物とする。account-serviceはEventBridgeへの
    // 発行とスキーマ登録に徹し、誰が購読しているかを一切知らない。
    // このマイルストーンでは単一CDKスタックに同居させているが、コメントで境界を明示し、
    // 将来別リポジトリへ分割する際の切れ目として機能させる。
    // ==========================================================================

    // --- [account-service所有] EventBridgeカスタムバス + Schema Registry ------
    // 発行側(account-service)が自分のイベントスキーマをSchema Registryへ自己登録する
    // (ADR-0001)。購読側はこのスキーマにだけ依存し、account-serviceの内部DBスキーマは
    // 一切知らない。
    const domainEventBus = new events.EventBus(this, "AccountDomainEventBus", {
      eventBusName: "moneta-account-domain-events",
    });

    const eventSchemaRegistry = new eventschemas.CfnRegistry(this, "AccountEventSchemaRegistry", {
      registryName: EVENT_SCHEMA_REGISTRY_NAME,
      description: "account-serviceが発行するドメインイベントのスキーマ(docs/adr/0004)",
    });

    new eventschemas.CfnSchema(this, "AccountDomainEventSchema", {
      registryName: eventSchemaRegistry.attrRegistryName,
      type: "OpenApi3",
      schemaName: EVENT_SCHEMA_NAME,
      description:
        "account-serviceがEventBridgeへ発行するイベントのdetail形状。account-service/src/outbox.rsのEventEnvelopeが単一の真実源。",
      content: JSON.stringify({
        openapi: "3.0.0",
        info: { title: "AccountDomainEvent", version: "1.0.0" },
        paths: {},
        components: {
          schemas: {
            AWSEvent: {
              type: "object",
              required: ["detail-type", "resources", "detail", "id", "source", "time", "region", "version", "account"],
              properties: {
                detail: { $ref: "#/components/schemas/AccountDomainEventDetail" },
                "detail-type": { type: "string" },
                resources: { type: "array", items: { type: "string" } },
                source: { type: "string" },
                id: { type: "string" },
                time: { type: "string", format: "date-time" },
                region: { type: "string" },
                version: { type: "string" },
                account: { type: "string" },
              },
            },
            AccountDomainEventDetail: {
              type: "object",
              required: ["event_id", "account_id", "occurred_at", "kind", "data"],
              properties: {
                event_id: { type: "string", format: "uuid" },
                account_id: { type: "string", format: "uuid" },
                occurred_at: { type: "string", format: "date-time" },
                kind: { type: "string", enum: ["event", "rejection"] },
                data: {},
              },
            },
          },
        },
      }),
    });

    // --- [account-service所有] Outbox Relay: DSQLをポーリングしてEventBridgeへ発行 ---
    // account_events.published_atがNULLの行を1分間隔でポーリングし、EventBridgeへ発行する
    // トランザクショナルアウトボックス(docs/adr/0004)。DSQLのCDC(Kinesis配信)はアイドル時も
    // 固定費が発生するためコスト方針と非互換と判断し不採用、代わりにこの方式を採る。
    const outboxRelayFn = new lambda.Function(this, "AccountOutboxRelayFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("account-outbox-relay"),
      environment: {
        DATABASE_URL: `postgres://${APP_DB_ROLE}@${cluster.attrEndpoint}:5432/postgres?sslmode=require`,
        EVENT_BUS_NAME: domainEventBus.eventBusName,
      },
    });

    domainEventBus.grantPutEventsTo(outboxRelayFn);

    outboxRelayFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dsql:DbConnect"],
        resources: [cluster.attrResourceArn],
      }),
    );

    const outboxRelaySchedulerRole = new iam.Role(this, "OutboxRelaySchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    outboxRelayFn.grantInvoke(outboxRelaySchedulerRole);

    // EventBridge Schedulerの下限は1分。約1分の反映遅延は、ADR-0001が元々許容していた
    // 結果整合性のトレードオフとして受け入れる(docs/adr/0004)。
    new scheduler.CfnSchedule(this, "OutboxRelaySchedule", {
      scheduleExpression: "rate(1 minute)",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: outboxRelayFn.functionArn,
        roleArn: outboxRelaySchedulerRole.roleArn,
      },
    });

    // --- [Query Service所有] 読み取りモデル(DynamoDB) -------------------------
    // 「キーバリューだから」ではなく、DSQL側の正規化された行をQuery APIがそのまま返せる
    // view(JSON)に変換して格納する場所として選んでいる(docs/adr/0004)。on-demand課金
    // なのでアイドル時の固定費はない。
    const accountViewTable = new dynamodb.Table(this, "AccountViewTable", {
      tableName: "moneta-account-views",
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // --- [Query Service所有] Query Projector: イベント→view変換 ---------------
    const queryProjectorFn = new lambda.Function(this, "AccountQueryProjectorFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("account-query-projector"),
      environment: {
        TABLE_NAME: accountViewTable.tableName,
      },
    });

    accountViewTable.grantWriteData(queryProjectorFn);
    // account-serviceのDSQLクラスタへは一切アクセスしない(EventBridgeのdetailだけで完結)。

    // --- [Query Service所有] EventBridge Rule(購読条件) -----------------------
    // 「どのイベント種別がview構築に必要か」はQuery Service自身の関心事なので、Ruleは
    // account-service側ではなくここ(購読側)で定義する。ADR-0001の該当記述(発行側がRuleを
    // 定義する、という趣旨の一文)はこの理由により誤りと判断し、docs/adr/0001で訂正した
    // (docs/adr/0004参照)。account.event.*のみ購読し、rejection(却下)はviewを変化させない
    // ため対象外にする。
    new events.Rule(this, "AccountEventSubscriptionRule", {
      eventBus: domainEventBus,
      eventPattern: {
        source: [EVENT_SOURCE],
        detailType: ACCOUNT_EVENT_DETAIL_TYPES,
      },
      targets: [new targets.LambdaFunction(queryProjectorFn)],
    });

    // --- [Query Service所有] 照会API: API Gateway REST API + DynamoDB直接統合 --
    // Lambdaを介さず、VTLでGetItemへ直結する(書き込み経路の将来の直接SQS統合と対称的な
    // 思想、docs/adr/0004)。REST API(HTTP APIではない)を使うのは、AWSサービスへの直接統合
    // (VTL)がREST API限定の機能のため。
    const queryApiDynamoRole = new iam.Role(this, "QueryApiDynamoRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });
    queryApiDynamoRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [accountViewTable.tableArn],
      }),
    );

    const queryApi = new apigateway.RestApi(this, "AccountQueryApi", {
      restApiName: "moneta-account-query-api",
      deployOptions: { stageName: "prod" },
    });

    const getAccountIntegration = new apigateway.AwsIntegration({
      service: "dynamodb",
      action: "GetItem",
      options: {
        credentialsRole: queryApiDynamoRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          "application/json": JSON.stringify({
            TableName: accountViewTable.tableName,
            Key: {
              accountId: { S: "$input.params('accountId')" },
            },
          }),
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              // DynamoDBはGetItemで見つからなくてもHTTP 200・空ボディを返すため、
              // 「見つからない」の判定と404への変換はここ(VTL)で行う。DynamoDBの1アイテムの
              // `view`属性がそのままQuery APIのレスポンスJSON(docs/adr/0004)。
              "application/json": [
                '#if($input.path("$.Item") == "")',
                "#set($context.responseOverride.status = 404)",
                '{"message": "account not found"}',
                "#else",
                '$input.path("$.Item.view.S")',
                "#end",
              ].join("\n"),
            },
          },
        ],
      },
    });

    const accountsResource = queryApi.root.addResource("accounts");
    const accountResource = accountsResource.addResource("{accountId}");
    accountResource.addMethod("GET", getAccountIntegration, {
      methodResponses: [{ statusCode: "200" }, { statusCode: "404" }],
    });

    // --- Outputs ---------------------------------------------------------------
    new cdk.CfnOutput(this, "ClusterEndpoint", { value: cluster.attrEndpoint });
    new cdk.CfnOutput(this, "ClusterResourceArn", { value: cluster.attrResourceArn });
    new cdk.CfnOutput(this, "CommandQueueUrl", { value: commandQueue.queueUrl });
    new cdk.CfnOutput(this, "DeadLetterQueueUrl", { value: deadLetterQueue.queueUrl });
    new cdk.CfnOutput(this, "AccountServiceFunctionName", { value: fn.functionName });
    new cdk.CfnOutput(this, "LambdaExecutionRoleArn", { value: fn.role!.roleArn });
    new cdk.CfnOutput(this, "OutboxRelayFunctionName", { value: outboxRelayFn.functionName });
    // apply-schema.shがこのロールにもdsql:DbConnectをグラントする(outbox relayもDSQLへ
    // 接続するため)。
    new cdk.CfnOutput(this, "OutboxRelayExecutionRoleArn", { value: outboxRelayFn.role!.roleArn });
    new cdk.CfnOutput(this, "DomainEventBusName", { value: domainEventBus.eventBusName });
    new cdk.CfnOutput(this, "AccountViewTableName", { value: accountViewTable.tableName });
    new cdk.CfnOutput(this, "QueryProjectorFunctionName", { value: queryProjectorFn.functionName });
    new cdk.CfnOutput(this, "QueryApiUrl", { value: queryApi.url });
  }
}

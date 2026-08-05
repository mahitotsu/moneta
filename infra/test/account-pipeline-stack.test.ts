import { App } from "aws-cdk-lib/core";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AccountPipelineStack } from "../lib/account-pipeline-stack";

// cdk synthをそのまま走らせるテスト(Rust Lambdaのビルドを含む)。docs/adr/0004のQuery service
// 追加分(DynamoDB/EventBridge/Scheduler/REST API直接統合)が期待通り合成されることを確認する。
describe("AccountPipelineStack", () => {
  const app = new App();
  const stack = new AccountPipelineStack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const template = Template.fromStack(stack);

  test("creates the account view DynamoDB table with on-demand billing", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "moneta-account-views",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "accountId", KeyType: "HASH" }],
    });
  });

  test("creates a custom EventBridge bus and registers the domain event schema", () => {
    template.resourceCountIs("AWS::Events::EventBus", 1);
    template.hasResourceProperties("AWS::EventSchemas::Registry", {
      RegistryName: "moneta-account-service",
    });
    template.resourceCountIs("AWS::EventSchemas::Schema", 1);
  });

  test("schedules the outbox relay at the EventBridge Scheduler's 1-minute minimum interval", () => {
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(1 minute)",
    });
  });

  test("query service subscribes only to account.event.* detail-types, not rejections", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["account-service"],
        "detail-type": [
          "account.event.Opened",
          "account.event.Deposited",
          "account.event.Withdrawn",
          "account.event.Frozen",
          "account.event.Unfrozen",
          "account.event.Closed",
        ],
      },
    });
  });

  test("creates the transfer saga DynamoDB table with on-demand billing", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "moneta-transfer-sagas",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "transferId", KeyType: "HASH" }],
    });
  });

  test("creates a separate FIFO queue (with its own DLQ) for transfer commands, distinct from the account command queue", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "moneta-transfer-commands-main.fifo",
      FifoQueue: true,
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "moneta-transfer-commands.fifo",
      FifoQueue: true,
    });
  });

  test("transfer-saga-step subscribes to any account-service event carrying a correlation_id, regardless of event vs. rejection (docs/adr/0010)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["account-service"],
        detail: { correlation_id: [{ exists: true }] },
      },
    });
  });

  test("transfer-service functions may send to the account command queue but never get dsql:DbConnect", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sqs:SendMessage",
          }),
        ]),
      },
    });
    // account-serviceの命令経路と同じく、transfer-serviceもDSQLへは一切触れない
    // (docs/adr/0010決定1: account-serviceへは公開インターフェース経由でしか関わらない)。
    const policies = template.findResources("AWS::IAM::Policy");
    const transferPolicies = Object.entries(policies).filter(([id]) => id.includes("Transfer"));
    for (const [, policy] of transferPolicies) {
      const statements = policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>;
      for (const statement of statements) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        expect(actions).not.toContain("dsql:DbConnect");
      }
    }
  });

  test("creates exactly nine Lambda functions: write path, outbox relay, query projector, schema migrator, the two transfer-service functions (command intake, saga step), the schema Provider framework's own handler, and the two Web UI hosting custom-resource handlers (S3 auto-delete-objects, BucketDeployment sync)", () => {
    template.resourceCountIs("AWS::Lambda::Function", 9);
  });

  test("applies the schema via a Custom Resource, granting only the two DSQL-connecting Lambdas' roles", () => {
    template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
      LambdaRoleArns: [
        { "Fn::GetAtt": Match.arrayWith(["AccountServiceFunctionServiceRole41347123"]) },
        { "Fn::GetAtt": Match.arrayWith(["AccountOutboxRelayFunctionServiceRoleC6C7598E"]) },
      ],
    });
  });

  test("the schema migrator gets dsql:DbConnectAdmin, not the regular dsql:DbConnect", () => {
    template.resourcePropertiesCountIs(
      "AWS::IAM::Policy",
      {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([Match.objectLike({ Action: "dsql:DbConnectAdmin" })]),
        }),
      },
      1,
    );
  });

  test("exposes GET /accounts/{accountId} as a direct DynamoDB integration, not a Lambda proxy", () => {
    // Type: "AWS" (not "AWS_PROXY") is what distinguishes a direct service integration from a
    // Lambda proxy. The Uri itself synthesizes as a region-dependent Fn::Join, not a plain
    // string, so the request template's TableName/Key mapping is the more robust thing to assert.
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      Integration: Match.objectLike({
        Type: "AWS",
        IntegrationHttpMethod: "POST",
        RequestTemplates: Match.objectLike({
          "application/json": Match.objectLike({
            "Fn::Join": Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp("TableName"), Match.stringLikeRegexp("accountId")]),
            ]),
          }),
        }),
      }),
    });
  });

  // 取引履歴(docs/adr/0009)。GetItemではなくQueryを使う直接統合であること、履歴専用
  // テーブルへのdynamodb:Query権限だけが付与されていること(GetItem権限と混同していないか)
  // を確認する。
  test("exposes GET /accounts/{accountId}/transactions as a direct DynamoDB Query integration", () => {
    // Uriはdynamodb:action/{GetItem,Query}で終わるFn::Join(パーティション部分がトークン化
    // されている)。GetItem統合と区別する一番頑健な手がかりとして使う。
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      Integration: Match.objectLike({
        Type: "AWS",
        IntegrationHttpMethod: "POST",
        Uri: Match.objectLike({
          "Fn::Join": Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp("action/Query$")])]),
        }),
      }),
    });
  });

  test("creates the account history table with a composite key (accountId, sk) separate from the view table", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "moneta-account-history",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "accountId", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    });
  });

  test("only account-service and the outbox relay get dsql:DbConnect (query projector never touches DSQL)", () => {
    template.resourcePropertiesCountIs(
      "AWS::IAM::Policy",
      {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([Match.objectLike({ Action: "dsql:DbConnect" })]),
        }),
      },
      2,
    );
  });

  // Web UIホスティング(docs/adr/0007)。queryApi/commandApiはどちらもパスが/accounts/{id}
  // から始まるため、CloudFrontのcache behavior(パスのみで振り分け)では区別できない——
  // /query-api・/command-apiというprefix + CloudFront Functionによるprefix剥がしで
  // 区別している、という設計の要である振り分けが実際に合成されることを確認する。
  test("routes /query-api/* and /command-api/* to their respective REST APIs with caching disabled", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/query-api/*",
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", // AWS managed: CachingDisabled
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({ EventType: "viewer-request" }),
            ]),
          }),
          Match.objectLike({
            PathPattern: "/command-api/*",
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({ EventType: "viewer-request" }),
            ]),
          }),
        ]),
      }),
    });
  });

  test("forwards the Idempotency-Key header to the command API origin (CloudFront drops unlisted headers by default)", () => {
    template.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
      OriginRequestPolicyConfig: Match.objectLike({
        HeadersConfig: {
          HeaderBehavior: "whitelist",
          Headers: Match.arrayWith(["Idempotency-Key"]),
        },
      }),
    });
  });

  test("the default behavior serves the Web UI bucket via Origin Access Control, not a public bucket", () => {
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});

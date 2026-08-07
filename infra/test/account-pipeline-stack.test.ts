import { App } from "aws-cdk-lib/core";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AccountPipelineStack } from "../lib/account-pipeline-stack";

// cdk synthをそのまま走らせるテスト(Rust Lambdaのビルドを含む)。docs/adr/0004のQuery service
// 追加分(DynamoDB/EventBridge/REST API直接統合)、docs/adr/0013のaccount-service自身の
// DynamoDB移行が期待通り合成されることを確認する。
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

  // docs/adr/0013: ポーリング(EventBridge Scheduler)ではなく、accountEventsTableの
  // DynamoDB Streamsが直接outbox projectorをトリガーする。
  test("account_events table has a stream, and the outbox projector is wired to it via an event source mapping", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "moneta-account-events",
      StreamSpecification: { StreamViewType: "NEW_IMAGE" },
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      StartingPosition: "TRIM_HORIZON",
      FunctionResponseTypes: ["ReportBatchItemFailures"],
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

  // dynamodb.TableのデフォルトはRemovalPolicy.RETAINで、これを明示しないと変更セットの
  // ロールバック時にもテーブルが削除されない。実際にこれが原因で、テーブル作成失敗による
  // ロールバック後の再デプロイが「テーブルは既に存在する」で失敗した(TransferSagaTable)。
  // 全てのDynamoDBテーブルがこの落とし穴を回避できているかを固定する回帰テスト
  // (docs/adr/0011でTransferAccountOwnersTableを、docs/adr/0013でaccount-service自身の
  // 3テーブルを追加)。
  test("all DynamoDB tables are set to DESTROY on stack/changeset rollback, not the RETAIN default", () => {
    const tables = template.findResources("AWS::DynamoDB::Table");
    const tableNames = Object.values(tables).map((table) => table.Properties.TableName);
    expect(tableNames.sort()).toEqual(
      [
        "moneta-account-events",
        "moneta-account-history",
        "moneta-account-views",
        "moneta-accounts",
        "moneta-processed-messages",
        "moneta-transfer-account-owners",
        "moneta-transfer-sagas",
      ].sort(),
    );
    for (const table of Object.values(tables)) {
      expect(table.DeletionPolicy).toBe("Delete");
      expect(table.UpdateReplacePolicy).toBe("Delete");
    }
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

  test("transfer-service functions may send to the account command queue (docs/adr/0010決定1: account-serviceへは公開インターフェース経由でしか関わらない)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sqs:SendMessage",
          }),
        ]),
      },
    });
  });

  test("creates exactly eight Lambda functions: write path, outbox projector, query projector, the three transfer-service functions (command intake, saga step, owner projector), and the two Web UI hosting custom-resource handlers (S3 auto-delete-objects, BucketDeployment sync)", () => {
    template.resourceCountIs("AWS::Lambda::Function", 8);
  });

  // docs/adr/0013: grantReadWriteData()はdynamodb:TransactWriteItemsを含まないため
  // (AWS公式ドキュメントで確認済み)、明示的に別途grantしている。account-serviceの3テーブル
  // 全てに対してこの権限が付与されていることを固定する回帰テスト。CDKは同一プリンシパルへの
  // 複数grantを1つのIAM::Policyリソースにまとめるため、ステートメント数(リソースARN単位)で
  // 数える。
  test("account-service gets an explicit dynamodb:TransactWriteItems grant covering all three of its own tables (not covered by grantReadWriteData)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const transactWriteResources = new Set<string>();
    for (const policy of Object.values(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement as Array<{
        Action: string | string[];
        Resource: unknown;
      }>;
      for (const statement of statements) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        if (actions.includes("dynamodb:TransactWriteItems")) {
          const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
          resources.forEach((r) => transactWriteResources.add(JSON.stringify(r)));
        }
      }
    }
    expect(transactWriteResources.size).toBe(3);
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

  // docs/adr/0004・0013: query projectorはEventBridgeのdetailだけで完結し、
  // account-serviceの内部ストア(accountsTable等)への読み取り権限を一切持たない。
  test("query projector never gets IAM access to account-service's own tables (accountsTable/accountEventsTable/processedMessagesTable)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const queryProjectorPolicies = Object.entries(policies).filter(([id]) => id.includes("QueryProjector"));
    for (const [, policy] of queryProjectorPolicies) {
      const statements = policy.Properties.PolicyDocument.Statement as Array<{ Resource: unknown }>;
      for (const statement of statements) {
        const resources = JSON.stringify(statement.Resource);
        expect(resources).not.toMatch(/AccountsTable|AccountEventsTable|ProcessedMessagesTable/);
      }
    }
  });

  // docs/adr/0006決定5: 金額の精度は小数点以下2桁まで(実デプロイでDBラウンドトリップ由来の
  // スケールのブレを発見したことを契機に、APIの仕様として明示した)。3桁以上はAPI Gatewayの
  // リクエスト検証で構造的に拒否する(account-domainのAMOUNT_DECIMAL_PLACESと合わせる)。
  test("amount/initial_balance JSON Schema models allow at most 2 decimal places", () => {
    const models = template.findResources("AWS::ApiGateway::Model");
    // SchemaはCFNテンプレート上インラインオブジェクト(JSON文字列ではない)。金額系モデル
    // (initial_balance/amount)だけがpatternを持つ(FreezeCommandModelはenumなので対象外)。
    const patterns = Object.values(models)
      .map((model) => {
        const properties = model.Properties.Schema.properties as Record<string, { pattern?: string }>;
        return Object.values(properties)
          .map((prop) => prop.pattern)
          .filter((pattern): pattern is string => pattern !== undefined);
      })
      .flat();
    expect(patterns).toHaveLength(2); // OpenCommandModel(initial_balance) + AmountCommandModel(amount)
    for (const pattern of patterns) {
      expect(pattern).toBe("^-?\\d+(\\.\\d{1,2})?$");
    }
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

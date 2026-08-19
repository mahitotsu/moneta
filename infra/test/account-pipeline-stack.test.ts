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
  // 3テーブルを、docs/adr/0012でTransferStatusViewTableを、docs/adr/0015でAccountNumbersTable
  // を、docs/adr/0017でCustomerTransfersTableを、docs/adr/0024でpoints-service/fee-service
  // の5テーブルを、docs/adr/0026でPointsHistoryTableを追加)。
  test("all DynamoDB tables are set to DESTROY on stack/changeset rollback, not the RETAIN default", () => {
    const tables = template.findResources("AWS::DynamoDB::Table");
    const tableNames = Object.values(tables).map((table) => table.Properties.TableName);
    expect(tableNames.sort()).toEqual(
      [
        "moneta-account-events",
        "moneta-account-history",
        "moneta-account-numbers",
        "moneta-account-views",
        "moneta-accounts",
        "moneta-customer-accounts",
        "moneta-customer-transfers",
        "moneta-fee-events",
        "moneta-fee-reservations",
        "moneta-points",
        "moneta-points-events",
        "moneta-points-history",
        "moneta-points-idempotency",
        "moneta-processed-messages",
        "moneta-transfer-account-owners",
        "moneta-transfer-sagas",
        "moneta-transfer-status-view",
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

  test("transfer-saga-step subscribes to any account-service or fee-service event carrying a correlation_id, regardless of event vs. rejection (docs/adr/0010, docs/adr/0024決定7: fee.event.FeeReservedが同じRuleに相乗りする)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["account-service", "fee-service"],
        detail: { correlation_id: [{ exists: true }] },
      },
    });
  });

  test("fee-points-observation subscribes only to points-service events carrying a correlation_id (docs/adr/0024決定7)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["points-service"],
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

  test("creates exactly twenty Lambda functions: write path, outbox projector, query projector, account number projector, customer accounts projector, the three auth-service functions (pre sign-up, post confirmation, post authentication), the five transfer-service functions (command intake, saga step, owner projector, status projector, history projector), the two points-service functions (command intake, outbox projector), the three fee-service functions (command intake, points observation, outbox projector), and the two Web UI hosting custom-resource handlers (S3 auto-delete-objects, BucketDeployment sync)", () => {
    template.resourceCountIs("AWS::Lambda::Function", 20);
  });

  // docs/adr/0015: owner_projector.rs(docs/adr/0011)と同じ理由でaccount.event.Openedのみ
  // 購読する(口座番号は不変データなので、開設イベント以外を見る必要がない)。
  test("account number projector subscribes only to account.event.Opened", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["account-service"],
        "detail-type": ["account.event.Opened"],
      },
    });
  });

  // docs/adr/0013: grantReadWriteData()はdynamodb:TransactWriteItemsを含まないため
  // (AWS公式ドキュメントで確認済み)、明示的に別途grantしている。account-serviceの3テーブル
  // 全てに対してこの権限が付与されていることを固定する回帰テスト。CDKは同一プリンシパルへの
  // 複数grantを1つのIAM::Policyリソースにまとめるため、ステートメント数(リソースARN単位)で
  // 数える。
  test("account-service gets an explicit dynamodb:TransactWriteItems grant covering all three of its own tables (not covered by grantReadWriteData)", () => {
    // docs/adr/0024でpoints-service/fee-serviceも同じTransactWriteItemsパターンを再利用した
    // ため、スタック全体を横断して数える(以前の実装)とaccount-service専用の回帰テストで
    // なくなってしまう。account-serviceの実行ロールのポリシーだけに絞り込む——CDKは
    // `new lambda.Function(this, "AccountServiceFunction", ...)`のデフォルトロールに
    // `<ConstructId>ServiceRoleDefaultPolicy<hash>`という論理IDでポリシーを生成する。
    const policies = template.findResources("AWS::IAM::Policy");
    const transactWriteResources = new Set<string>();
    for (const [logicalId, policy] of Object.entries(policies)) {
      if (!logicalId.startsWith("AccountServiceFunctionServiceRoleDefaultPolicy")) continue;
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

  // docs/adr/0015: 口座番号(PK)↔accountId(GSI)を両方向で引けることを固定する。
  test("creates the account numbers table with a byAccountId GSI for the reverse lookup", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "moneta-account-numbers",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "accountNumber", KeyType: "HASH" }],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "byAccountId",
          KeySchema: [{ AttributeName: "accountId", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        }),
      ]),
    });
  });

  test("exposes GET /account-numbers/{accountNumber} as a direct DynamoDB GetItem integration", () => {
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      Integration: Match.objectLike({
        Type: "AWS",
        IntegrationHttpMethod: "POST",
        RequestTemplates: Match.objectLike({
          "application/json": Match.objectLike({
            "Fn::Join": Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp("TableName"), Match.stringLikeRegexp("accountNumber")]),
            ]),
          }),
        }),
      }),
    });
  });

  // 取引履歴API(178行目)と同じ判定手法: Uriの末尾がaction/Queryかどうかで、GetItem統合の
  // GET /account-numbers/{accountNumber}と区別する。
  test("exposes GET /accounts/{accountId}/account-number as a direct DynamoDB Query integration against the byAccountId GSI", () => {
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      Integration: Match.objectLike({
        Type: "AWS",
        IntegrationHttpMethod: "POST",
        Uri: Match.objectLike({
          "Fn::Join": Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp("action/Query$")])]),
        }),
        RequestTemplates: Match.objectLike({
          "application/json": Match.objectLike({
            "Fn::Join": Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp("byAccountId")])]),
          }),
        }),
      }),
    });
  });

  // docs/production-readiness-matrix.md O1: ADR-0002決定6は「DLQの滞留数・最古メッセージの
  // 経過時間にCloudWatchアラームを張る」と決定していたが、実装が伴っていなかった(2026-08-10発見)。
  test("all four DLQs (account command, transfer command, fee command, points command) have alarms on messages-visible and oldest-message-age", () => {
    // docs/adr/0024でFeeCommandDlq/PointsCommandDlqにも同じaddDlqAlarmsを適用したため、
    // 4キュー×2アラーム=8件になった。
    template.resourceCountIs("AWS::CloudWatch::Alarm", 8);
    // DimensionsのValueはキュー論理IDへのFn::GetAtt(QueueName)であり、キュー名の文字列
    // リテラルとしては現れない(CDKの`metricApproximateNumberOfMessagesVisible`の実際の
    // 出力を実行して確認済み)。どのキューかまでは論理IDから間接的にしか分からないため、
    // ここでは「両メトリクスとも4件ずつ(account/transfer/fee/points用)存在する」ことだけを
    // 確認する。
    for (const metricName of ["ApproximateNumberOfMessagesVisible", "ApproximateAgeOfOldestMessage"]) {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: metricName,
        Namespace: "AWS/SQS",
        Dimensions: Match.arrayWith([Match.objectLike({ Name: "QueueName" })]),
      });
      const matches = template.findResources("AWS::CloudWatch::Alarm", {
        Properties: { MetricName: metricName },
      });
      expect(Object.keys(matches)).toHaveLength(4);
    }
  });

  // docs/production-readiness-matrix.md L3: account_events(監査ログ)とprocessed_messages
  // (冪等性ログ)は追記専用であるべきで、既存項目のUpdate/Deleteは想定されていない
  // (2026-08-10発見: 修正前は`grantWriteData`が意図せずUpdateItem/DeleteItem/BatchWriteItemも
  // 付与していた——コメントは「PutItemのみ」と書いていたのに、実際に要求するIAMアクションが
  // それより広いという、ADR-0013決定5と同種の「実際に要求されるアクションを検証せず思い込んでいた」
  // ケース)。
  test("account_events and processed_messages tables never grant UpdateItem/DeleteItem/BatchWriteItem to any function (append-only)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const forbiddenActions = ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"];
    for (const [id, policy] of Object.entries(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement as Array<{
        Action: string | string[];
        Resource: unknown;
      }>;
      for (const statement of statements) {
        const resources = JSON.stringify(statement.Resource);
        if (!/AccountEventsTable|ProcessedMessagesTable/.test(resources)) continue;
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        for (const forbidden of forbiddenActions) {
          if (actions.includes(forbidden)) {
            throw new Error(`policy ${id} grants ${forbidden} on account_events/processed_messages`);
          }
        }
      }
    }
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

  // docs/adr/0012決定1: TransferSagaTable(書き込み専用)を直接晒さず、DynamoDB Streamsで
  // 専用のTransferStatusViewへ投影する。
  test("transfer_sagas table has a stream, and the status projector is wired to it via an event source mapping", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "moneta-transfer-sagas",
      StreamSpecification: { StreamViewType: "NEW_IMAGE" },
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "moneta-transfer-status-view",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "transferId", KeyType: "HASH" }],
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      StartingPosition: "TRIM_HORIZON",
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  // docs/adr/0017: TransferSagaTableへのGSI追加ではなく、transfer-status-projectorと同型の
  // 別の専用投影(transfer-history-projector)を同じStreamsに追加で結線する。1つのDynamoDB
  // ストリームに複数のLambdaトリガーが独立して購読できることの固定(2つ目のEventSourceMapping
  // が実際に作られているか)。
  test("transfer_sagas table has two independent stream consumers: transfer-status-projector and transfer-history-projector", () => {
    // ベーステーブルの範囲キーはtransferId(実デプロイでの確認で判明した設計修正——
    // 当初のupdatedAt#transferIdでは状態遷移のたびに別アイテムが積み上がるバグがあった)。
    // 新しい順の並び替えはbyUpdatedAt GSIに分離する。
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "moneta-customer-transfers",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "ownerId", KeyType: "HASH" },
        { AttributeName: "transferId", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "byUpdatedAt",
          KeySchema: [
            { AttributeName: "ownerId", KeyType: "HASH" },
            { AttributeName: "updatedAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        }),
      ]),
    });
    // account-outbox-projectorもTRIM_HORIZONの別のEventSourceMapping(AccountEventsTable向け)を
    // 持つため、StartingPositionだけでは絞り込めない——CDKの自動生成論理IDに元の関数名が
    // そのまま現れることを頼りに、TransferSagaTable向けの2つだけを数える。
    const mappings = template.findResources("AWS::Lambda::EventSourceMapping", {
      Properties: Match.objectLike({ StartingPosition: "TRIM_HORIZON" }),
    });
    const transferSagaMappings = Object.keys(mappings).filter(
      (id) => id.includes("TransferStatusProjectorFunction") || id.includes("TransferHistoryProjectorFunction"),
    );
    expect(transferSagaMappings).toHaveLength(2);
  });

  test("exposes GET /customers/me/transfers as a direct DynamoDB Query integration against the byUpdatedAt GSI, keyed off the Cognito sub claim, newest first", () => {
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      AuthorizationType: "COGNITO_USER_POOLS",
      Integration: Match.objectLike({
        Type: "AWS",
        IntegrationHttpMethod: "POST",
        Uri: Match.objectLike({
          "Fn::Join": Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp("action/Query$")])]),
        }),
        RequestTemplates: Match.objectLike({
          "application/json": Match.objectLike({
            "Fn::Join": Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp("byUpdatedAt.*authorizer\\.claims\\.sub.*ScanIndexForward.*false")]),
            ]),
          }),
        }),
      }),
    });
  });

  test("exposes GET /transfers/{transferId} as a direct DynamoDB integration against TransferStatusView, not TransferSagaTable", () => {
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      Integration: Match.objectLike({
        Type: "AWS",
        IntegrationHttpMethod: "POST",
        RequestTemplates: Match.objectLike({
          // テーブル名自体はRef(実体名は合成時点では解決されない)なので、リテラルとして
          // 常に現れる文字列(account-serviceの既存テストと同じ"TableName"、パスパラメータ名の
          // "transferId")で判定する。
          "application/json": Match.objectLike({
            "Fn::Join": Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp("TableName"), Match.stringLikeRegexp("transferId")]),
            ]),
          }),
        }),
        // docs/adr/0025: 送金詳細画面が手数料を表示できるよう、cashFee/pointsUsedもレスポンスへ含める。
        // Match.allOfはこのaws-cdk-libのバージョンに無いため、肯定先読みを2つ重ねた1つの
        // 正規表現で「両方含む」を表現する——テンプレート文字列は改行を含むため、`.`ではなく
        // `[\s\S]`を使う(`.`はデフォルトで改行にマッチしない)。
        IntegrationResponses: Match.arrayWith([
          Match.objectLike({
            ResponseTemplates: Match.objectLike({
              "application/json": Match.stringLikeRegexp('(?=[\\s\\S]*"cashFee")(?=[\\s\\S]*"pointsUsed")'),
            }),
          }),
        ]),
      }),
    });
  });

  // docs/adr/0012決定3: Idempotency-Keyヘッダーは要求しない(account-serviceのコマンドAPIとは
  // 異なる)。決定4のリソース構成(PUT /transfers/{id}、POST confirm/cancel、PUT recall)が
  // 全てSQS直接統合として存在することを確認する。
  test("transfer command API exposes Start/Confirm/Cancel/Recall as SQS direct integrations without requiring an Idempotency-Key header", () => {
    const methods = template.findResources("AWS::ApiGateway::Method");
    const transferSqsMethods = Object.values(methods).filter(
      (m) =>
        m.Properties?.Integration?.Type === "AWS" &&
        // キューの物理名(moneta-transfer-commands-main.fifo)はFn::GetAttで参照されるため
        // 合成時点ではリテラルに現れない。論理ID(TransferCommandQueue)で判定する。
        JSON.stringify(m.Properties?.Integration?.Uri ?? "").includes("TransferCommandQueue"),
    );
    expect(transferSqsMethods).toHaveLength(4); // Start(PUT)/Confirm(POST)/Cancel(POST)/Recall(PUT)
    for (const method of transferSqsMethods) {
      expect(method.Properties.RequestParameters ?? {}).not.toHaveProperty(
        "method.request.header.Idempotency-Key",
      );
    }
  });

  test("routes /transfer-query-api/* and /transfer-command-api/* to their respective REST APIs with caching disabled", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: "/transfer-query-api/*" }),
          Match.objectLike({ PathPattern: "/transfer-command-api/*" }),
        ]),
      }),
    });
  });

  test("routes /account-number-query-api/* to the account number query REST API (docs/adr/0015)", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/account-number-query-api/*",
            FunctionAssociations: Match.arrayWith([Match.objectLike({ EventType: "viewer-request" })]),
          }),
        ]),
      }),
    });
  });

  // docs/adr/0025決定1: 項目が存在しない場合は404ではなく{"balance": "0"}を返す——
  // ヘッダーに常に何かを表示したいという決定2の要件に対する既定値。
  test("exposes GET /customers/me/points as a direct DynamoDB GetItem integration defaulting to balance 0", () => {
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      Integration: Match.objectLike({
        Type: "AWS",
        IntegrationHttpMethod: "POST",
        RequestTemplates: Match.objectLike({
          "application/json": Match.objectLike({
            "Fn::Join": Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp("TableName"), Match.stringLikeRegexp("ownerId")])]),
          }),
        }),
        IntegrationResponses: Match.arrayWith([
          Match.objectLike({
            ResponseTemplates: Match.objectLike({
              "application/json": Match.stringLikeRegexp('"balance": "0"'),
            }),
          }),
        ]),
      }),
    });
  });

  test("routes /points-query-api/* to the points query REST API (docs/adr/0025)", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/points-query-api/*",
            FunctionAssociations: Match.arrayWith([Match.objectLike({ EventType: "viewer-request" })]),
          }),
        ]),
      }),
    });
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
    // OpenCommandModel(initial_balance) + DepositCommandModel(amount) + WithdrawalCommandModel
    // (amount、docs/adr/0023でAmountCommandModelから分離) + StartTransferModel(amount、
    // docs/adr/0012決定4がACCOUNT-serviceの決定5をそのまま踏襲)。
    expect(patterns).toHaveLength(4);
    for (const pattern of patterns) {
      expect(pattern).toBe("^-?\\d+(\\.\\d{1,2})?$");
    }
  });

  // Web UIホスティング(docs/adr/0007)。queryApi/commandApiはどちらもパスが/accounts/{id}
  // から始まるため、CloudFrontのcache behavior(パスのみで振り分け)では区別できない——
  // /query-api・/command-apiというprefix + CloudFront Functionによるprefix剥がしで
  // 区別している、という設計の要である振り分けが実際に合成されることを確認する。
  test("routes /query-api/* and /command-api/* to their respective REST APIs", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/query-api/*",
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({ EventType: "viewer-request" }),
            ]),
          }),
          Match.objectLike({
            PathPattern: "/command-api/*",
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

  // --- docs/adr/0016: Amazon Cognitoによる実認証 ----------------------------

  test("Cognito User Pool allows self-signup and wires PreSignUp/PostConfirmation/PostAuthentication triggers", () => {
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: false }),
      LambdaConfig: Match.objectLike({
        PreSignUp: Match.anyValue(),
        PostConfirmation: Match.anyValue(),
        PostAuthentication: Match.anyValue(),
      }),
    });
  });

  test("Cognito User Pool Client uses USER_PASSWORD_AUTH (docs/adr/0016決定1のトレードオフ)", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_PASSWORD_AUTH"]),
      GenerateSecret: false,
    });
  });

  // CDKのCognitoUserPoolsAuthorizerは1つのインスタンスを複数のRestApiへまたがって使うと
  // "Cannot attach authorizer to two different rest APIs"でsynth自体が失敗する(cdk synth時点で
  // 判明した実際の制約)。6つのRestApi(AccountQueryApi・AccountCommandApi・TransferQueryApi・
  // TransferCommandApi・AccountNumberQueryApi・PointsQueryApi[docs/adr/0025])それぞれに1つずつ、
  // 同じuserPoolを指す別々のAuthorizerリソースを持つ。
  test("one Cognito User Pools authorizer per protected REST API (6 total), all backed by the same User Pool", () => {
    const authorizers = template.findResources("AWS::ApiGateway::Authorizer");
    const values = Object.values(authorizers);
    expect(values).toHaveLength(6);
    for (const authorizer of values) {
      expect(authorizer.Properties.Type).toBe("COGNITO_USER_POOLS");
    }
    const userPoolRefs = new Set(
      values.map((a) => JSON.stringify(a.Properties.ProviderARNs)),
    );
    // 全AuthorizerのProviderARNsが同じUser Poolを指している(別々のUser Poolを誤って
    // 作っていないことの確認)。
    expect(userPoolRefs.size).toBe(1);
  });

  // docs/adr/0016決定2: Deposit/Withdraw(外部チャネル、ADR-0009決定1)だけは認証を要求しない。
  // それ以外の全メソッド(15個中13個 + GET /customers/me/accounts + GET /customers/me/transfers
  // [docs/adr/0017] + GET /customers/me/points[docs/adr/0025] + 新設のGET
  // /customers/me/points/history[docs/adr/0026] = 17個)はCognito認証必須にする——この非対称
  // こそが今回の変更の核心なので、個数を固定する。
  test("17 of 19 API methods require Cognito auth; Deposit/Withdraw are the only two exceptions", () => {
    const methods = template.findResources("AWS::ApiGateway::Method");
    const allMethods = Object.values(methods);
    const authorized = allMethods.filter((m) => m.Properties?.AuthorizationType === "COGNITO_USER_POOLS");
    const unauthorized = allMethods.filter((m) => m.Properties?.AuthorizationType !== "COGNITO_USER_POOLS");

    expect(allMethods).toHaveLength(19);
    expect(authorized).toHaveLength(17);
    expect(unauthorized).toHaveLength(2);
    // 認証なしの2つが、まさにdeposits/withdrawalsのSQS統合であることを確認する
    // (Uriにキューの論理IDが現れる、既存のtransfer command API判定テストと同じ手法)。
    for (const method of unauthorized) {
      expect(JSON.stringify(method.Properties?.Integration?.Uri ?? "")).toContain("AccountCommandQueue");
    }
  });

  test("creates the customer accounts table (docs/adr/0016決定4) keyed by ownerId+accountId", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "moneta-customer-accounts",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "ownerId", KeyType: "HASH" },
        { AttributeName: "accountId", KeyType: "RANGE" },
      ],
    });
  });

  test("customer accounts projector subscribes only to account.event.Opened (same reasoning as owner_projector.rs/account_number_projector.rs)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["account-service"],
        "detail-type": ["account.event.Opened"],
      },
    });
  });

  test("exposes GET /customers/me/accounts as a direct DynamoDB Query integration keyed off the Cognito sub claim, not a client-supplied ownerId", () => {
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      AuthorizationType: "COGNITO_USER_POOLS",
      Integration: Match.objectLike({
        Type: "AWS",
        IntegrationHttpMethod: "POST",
        Uri: Match.objectLike({
          "Fn::Join": Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp("action/Query$")])]),
        }),
        RequestTemplates: Match.objectLike({
          "application/json": Match.objectLike({
            "Fn::Join": Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp("authorizer\\.claims\\.sub")]),
            ]),
          }),
        }),
      }),
    });
  });

  // docs/adr/0016: CloudFrontはOriginRequestPolicyのallowListにAuthorizationを含めることを
  // 拒否する("you cannot pass `Authorization`..."、cdk synth時点で判明)——CachePolicy側の
  // headerBehaviorでのみ転送できる。さらにTTLを全て0(=CACHING_DISABLED相当)にすると
  // 今度は実機デプロイ時点で"HeaderBehavior is invalid for policy with caching disabled"を
  // 返される(cdk synthは通るが実デプロイで判明)ため、1秒だけTTLを持たせている——結果整合性の
  // 最大約1分のラグを既に許容しているこのシステムからすれば無視できる窓であり、ADR-0007が
  // 意図した「結果整合性のあるレスポンスをCDNにキャッシュさせない」という性質を実質的に保つ。
  test("forwards the Authorization header to every customer-facing API origin via a near-zero-TTL CachePolicy (not OriginRequestPolicy)", () => {
    template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({
        DefaultTTL: 1,
        MinTTL: 0,
        MaxTTL: 1,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          HeadersConfig: {
            HeaderBehavior: "whitelist",
            Headers: ["Authorization"],
          },
        }),
      }),
    });
    // どのOriginRequestPolicyにもAuthorizationが紛れ込んでいないこと(CloudFront自体が拒否する
    // ため通常起こり得ないが、意図の固定として)。
    const originRequestPolicies = template.findResources("AWS::CloudFront::OriginRequestPolicy");
    for (const policy of Object.values(originRequestPolicies)) {
      const headers = policy.Properties?.OriginRequestPolicyConfig?.HeadersConfig?.Headers ?? [];
      expect(headers).not.toContain("Authorization");
    }
  });

  test("all 6 customer-facing CloudFront behaviors use the Authorization-forwarding CachePolicy, not the AWS-managed CachingDisabled policy", () => {
    const distributions = template.findResources("AWS::CloudFront::Distribution");
    const [distribution] = Object.values(distributions);
    const behaviors = distribution.Properties.DistributionConfig.CacheBehaviors as { PathPattern: string; CachePolicyId: unknown }[];
    const apiBehaviors = behaviors.filter((b) =>
      [
        "/query-api/*",
        "/command-api/*",
        "/transfer-query-api/*",
        "/transfer-command-api/*",
        "/account-number-query-api/*",
        "/points-query-api/*",
      ].includes(b.PathPattern),
    );
    expect(apiBehaviors).toHaveLength(6);
    for (const behavior of apiBehaviors) {
      expect(JSON.stringify(behavior.CachePolicyId)).not.toContain("4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
    }
  });
});

import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as eventschemas from "aws-cdk-lib/aws-eventschemas";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { DynamoEventSource, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as sqs from "aws-cdk-lib/aws-sqs";

// ADR-0002: maxReceiveCount is kept low. The two-stage retry (in-Lambda retry loop on
// optimistic-lock conflicts, then SQS-level redelivery) means only failures that survive
// 3 in-process retries ever reach SQS, so a long SQS-level retry budget isn't needed.
const MAX_RECEIVE_COUNT = 3;

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

    // Rust製6バイナリ(account-service・account-outbox-projectorはaccount-serviceパッケージ、
    // account-query-projectorはquery-serviceパッケージ——docs/adr/0008でクレートを分離した、
    // transfer-command-intake・transfer-saga-step・transfer-owner-projectorはtransfer-service
    // パッケージ)は全て同じワークスペースルート・同じ手順でビルドするため、パッケージ名・
    // バイナリ名だけを差し替えられるヘルパーに切り出して重複を避ける。
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

    const rustLambdaCode = (packageName: string, binaryName: string): lambda.Code =>
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
              `cargo build --release --target x86_64-unknown-linux-gnu -p ${packageName} --bin ${binaryName}`,
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

    // --- [account-service所有] 永続化ストア(DynamoDB、docs/adr/0013) ----------
    // account-serviceの書き込み側は3テーブルで完結する: 1口座1アイテムのaccounts、
    // 追記専用のイベントログ(アウトボックス)であるaccountEvents、冪等性ログの
    // processedMessages。1メッセージにつき1回のTransactWriteItemsでこの3テーブルへ
    // 原子的に書き込む(persistence.rsのapply_command)。
    const accountsTable = new dynamodb.Table(this, "AccountsTable", {
      tableName: "moneta-accounts",
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // PoCスタックのため自由に壊せるようにする(他のDynamoDBテーブルと同じ方針)。
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // account_eventsはDynamoDB Streamsでaccount-outbox-projectorへ配信する
    // (トランザクショナルアウトボックス、docs/adr/0004・0013)。NEW_IMAGEのみで足りる
    // (追記専用ログであり、更新前の値を見る必要がない)。
    const accountEventsTable = new dynamodb.Table(this, "AccountEventsTable", {
      tableName: "moneta-account-events",
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const processedMessagesTable = new dynamodb.Table(this, "ProcessedMessagesTable", {
      tableName: "moneta-processed-messages",
      partitionKey: { name: "messageId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
      code: rustLambdaCode("account-service", "account-service"),
      environment: {
        ACCOUNTS_TABLE_NAME: accountsTable.tableName,
        EVENTS_TABLE_NAME: accountEventsTable.tableName,
        PROCESSED_MESSAGES_TABLE_NAME: processedMessagesTable.tableName,
      },
    });

    fn.addEventSource(
      new SqsEventSource(commandQueue, {
        batchSize: 10, // FIFO queue maximum
        reportBatchItemFailures: true,
        // maxBatchingWindow is intentionally not set: unsupported for FIFO source queues.
      }),
    );

    // --- IAM: DynamoDB(docs/adr/0013) ------------------------------------------
    // grantReadWriteData()はdynamodb:TransactWriteItemsを含まない(AWS公式ドキュメントで
    // 確認済み)ため、TransactWriteItemsを使う3テーブルには明示的に別途grantする。
    //
    // 実機検証で判明: dynamodb:TransactWriteItemsを許可するだけでは不十分で、AWSのIAM認可は
    // TransactWriteItems自体に加えて、各TransactItemが実際に行う個別アクション(Put→PutItem、
    // Update→UpdateItem、ConditionCheck→ConditionCheckItem)も要求する(実デプロイで
    // AccessDeniedExceptionとして発見: 「no identity-based policy allows the
    // dynamodb:PutItem action」)。公式ドキュメントの一般的な記述だけでは気づけなかった挙動で、
    // CLAUDE.mdの「AWS/ライブラリの挙動は推測せず検証する」を地で行く形になった。
    accountsTable.grantReadWriteData(fn); // GetItem(読み込み) + PutItem/UpdateItem(新規/既存の書き込み)
    accountsTable.grant(fn, "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem");
    accountEventsTable.grantWriteData(fn); // PutItem(イベント追記)
    accountEventsTable.grant(fn, "dynamodb:TransactWriteItems");
    processedMessagesTable.grantWriteData(fn); // PutItem(冪等性ログ)
    processedMessagesTable.grant(fn, "dynamodb:TransactWriteItems");

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
                // コマンド発行元(例: transfer-service)が付与する不透明な相関ID(docs/adr/0010
                // 決定4)。発行しないコマンド(顧客の通常操作)ではフィールド自体が欠落する
                // (EventEnvelopeのskip_serializing_if)ため必須にしない。
                correlation_id: { type: "string" },
              },
            },
          },
        },
      }),
    });

    // --- [account-service所有] Outbox Projector: DynamoDB StreamsでEventBridgeへ発行 ---
    // accountEventsTableのDynamoDB Streams(NEW_IMAGE)をトリガーに、直接PutEventsする
    // トランザクショナルアウトボックス(docs/adr/0004・0013)。DynamoDB Streams自体には
    // 稼働の有無によらない時間課金がなく、Lambdaトリガー経由の読み取りは無料(AWS公式
    // ドキュメントで確認済み)なので、ポーリングを挟む理由がない。
    const outboxProjectorDlq = new sqs.Queue(this, "AccountOutboxProjectorDlq");

    const outboxProjectorFn = new lambda.Function(this, "AccountOutboxProjectorFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("account-service", "account-outbox-projector"),
      environment: {
        EVENT_BUS_NAME: domainEventBus.eventBusName,
      },
    });

    domainEventBus.grantPutEventsTo(outboxProjectorFn);

    outboxProjectorFn.addEventSource(
      new DynamoEventSource(accountEventsTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10, // EventBridge PutEventsの1リクエストあたり上限と揃える
        retryAttempts: 3,
        reportBatchItemFailures: true,
        onFailure: new SqsDestination(outboxProjectorDlq),
      }),
    );

    // --- [Query Service所有] 読み取りモデル(DynamoDB) -------------------------
    // account-serviceのaccountsテーブル(正規化された1口座1アイテム)をそのまま複製するの
    // ではなく、Query APIがそのまま返せるview(JSON)に変換して格納する場所として選んでいる
    // (docs/adr/0004)。on-demand課金なのでアイドル時の固定費はない。
    const accountViewTable = new dynamodb.Table(this, "AccountViewTable", {
      tableName: "moneta-account-views",
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // PoCスタックのため自由に壊せるようにする(他のリソースと同じ方針)。
      // dynamodb.TableのデフォルトはRemovalPolicy.RETAINであり、
      // 明示しないと変更セットのロールバック時にも削除されず、同名テーブルの再作成が
      // 「already exists」で失敗する(実デプロイで発見——TransferSagaTableの同種の事故を
      // 修正した際にこちらも同じ問題を抱えていることに気づいた)。
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 取引履歴(docs/adr/0009) — accountViewTableとは別の第二のread model。1アイテム=
    // 1トランザクション、ソートキーはナノ秒タイムスタンプ(ゼロパディング)+event_idで
    // 時刻順ソートと一意性の両方を満たす(crates/query-service/src/bin/query_projector.rs)。
    const accountHistoryTable = new dynamodb.Table(this, "AccountHistoryTable", {
      tableName: "moneta-account-history",
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- [Query Service所有] Query Projector: イベント→view変換 ---------------
    const queryProjectorFn = new lambda.Function(this, "AccountQueryProjectorFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("query-service", "account-query-projector"),
      environment: {
        TABLE_NAME: accountViewTable.tableName,
        HISTORY_TABLE_NAME: accountHistoryTable.tableName,
      },
    });

    accountViewTable.grantWriteData(queryProjectorFn);
    accountHistoryTable.grantWriteData(queryProjectorFn);
    // account-serviceの内部ストア(accountsTable等)へは一切アクセスしない(EventBridgeの
    // detailだけで完結)。

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
    queryApiDynamoRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [accountHistoryTable.tableArn],
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

    // --- [Query Service所有] 取引履歴API: API Gateway + DynamoDB Query直接統合 --
    // accountHistoryTableを新しい順(ScanIndexForward: false)に最大50件返す。ページネーション
    // はPoCスコープでは省略する(docs/adr/0009)。GetItem直接統合と同じ思想だが、こちらは
    // Query操作でItems配列が返るため、レスポンスVTLで#foreachによるJSON配列の組み立てが必要
    // ——ADR-0006がVTLの実機バグを繰り返し踏んだ経緯を踏まえ、デプロイ後にtest-invoke-method
    // で実機検証してから完了とする。
    const listTransactionsIntegration = new apigateway.AwsIntegration({
      service: "dynamodb",
      action: "Query",
      options: {
        credentialsRole: queryApiDynamoRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          "application/json": JSON.stringify({
            TableName: accountHistoryTable.tableName,
            KeyConditionExpression: "accountId = :accountId",
            ExpressionAttributeValues: {
              ":accountId": { S: "$input.params('accountId')" },
            },
            ScanIndexForward: false,
            Limit: 50,
          }),
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              // 各アイテムのentry属性(history_entry_from_eventが生成した、既にJSON文字列)を
              // カンマ区切りで連結してJSON配列を組み立てる。
              "application/json": [
                "#set($items = $input.path('$.Items'))",
                "[",
                "#foreach($item in $items)",
                "$item.entry.S#if($foreach.hasNext),#end",
                "#end",
                "]",
              ].join("\n"),
            },
          },
        ],
      },
    });

    const transactionsResource = accountResource.addResource("transactions");
    transactionsResource.addMethod("GET", listTransactionsIntegration, {
      methodResponses: [{ statusCode: "200" }],
    });

    // ==========================================================================
    // 書き込み経路API Gateway(docs/adr/0006) — [account-service所有]
    //
    // ADR-0002のメッセージライフサイクル図が元々想定していた形(API Gateway: 構造検証のみ
    // → SQS FIFO、Lambdaを挟まない)を実装する。読み取り経路(APIGW→DynamoDB GetItem直接統合)
    // と対称的な思想だが、SQSはQueryプロトコル(form-urlencoded)のAPIであり、DynamoDBの
    // JSON APIとは統合の形が異なる(AWS公式ドキュメントで確認済み、docs/adr/0006参照)。
    // ==========================================================================

    const commandApiSqsRole = new iam.Role(this, "CommandApiSqsRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });
    commandApiSqsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [commandQueue.queueArn],
      }),
    );

    const commandApi = new apigateway.RestApi(this, "AccountCommandApi", {
      restApiName: "moneta-account-command-api",
      deployOptions: { stageName: "prod" },
    });

    // Idempotency-Keyヘッダー(必須) → SQS MessageDeduplicationId。contentBasedDeduplication
    // は無効化されており(プロデューサー側が明示的に設定する前提)、VTLにはハッシュ化・
    // UUID生成の手段がないため、クライアント側にこのヘッダーを要求する(docs/adr/0006)。
    const commandRequestValidator = new apigateway.RequestValidator(this, "CommandRequestValidator", {
      restApi: commandApi,
      validateRequestBody: true,
      validateRequestParameters: true,
    });
    // ボディを持たないコマンド(Unfreeze/Close)用。ボディ検証はせず、ヘッダーの必須チェックのみ行う。
    const commandParamsOnlyValidator = new apigateway.RequestValidator(this, "CommandParamsOnlyValidator", {
      restApi: commandApi,
      validateRequestBody: false,
      validateRequestParameters: true,
    });

    // 金額・残高はJSON上「文字列」(rust_decimal の serde-with-str機能。
    // crates/account-domain/Cargo.toml、テストevent_serializes_amount_as_string_not_floatで確認済み)。
    // 小数点以下は最大2桁まで(docs/adr/0006決定5、account-domainの`AMOUNT_DECIMAL_PLACES`が
    // 単一の真実源)——実デプロイでDBラウンドトリップ由来のスケールのブレ(900.000000のような
    // 表示)を発見したことを契機に、精度をAPIの仕様として明示した。「正の値か」等の業務ルール
    // (DomainError::InvalidAmount)には踏み込まない(ADR-0002の境界)が、桁数は構造検証の範囲と
    // 位置づける。
    const decimalStringSchema: apigateway.JsonSchema = {
      type: apigateway.JsonSchemaType.STRING,
      pattern: "^-?\\d+(\\.\\d{1,2})?$",
    };

    // owner_id: 口座の名義(顧客識別子)。docs/adr/0011で、振替(同一名義間)/振込(名義不一致)を
    // サーバ側で判定するための実データとしてAccount aggregateに追加した。空文字列は拒否する
    // (Web UIは常にサインイン済み顧客名を送る——ダミーサインインであり認証ではない、
    // ADR-0007/0009の「認証UIなし」は撤回しない)。
    const ownerIdSchema: apigateway.JsonSchema = {
      type: apigateway.JsonSchemaType.STRING,
      minLength: 1,
    };

    const openModel = commandApi.addModel("OpenCommandModel", {
      contentType: "application/json",
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ["owner_id", "initial_balance"],
        properties: { owner_id: ownerIdSchema, initial_balance: decimalStringSchema },
        additionalProperties: false,
      },
    });
    const amountModel = commandApi.addModel("AmountCommandModel", {
      contentType: "application/json",
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ["amount"],
        properties: { amount: decimalStringSchema },
        additionalProperties: false,
      },
    });
    // FreezeReasonの値はRustのenumバリアント名とそのまま一致させる(rename_allなし)。
    const freezeModel = commandApi.addModel("FreezeCommandModel", {
      contentType: "application/json",
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ["reason"],
        properties: {
          reason: {
            type: apigateway.JsonSchemaType.STRING,
            enum: ["SuspectedFraud", "CourtOrder", "CustomerRequest"],
          },
        },
        additionalProperties: false,
      },
    });

    // AccountCommandEnvelope(persistence.rs)が期待するJSON本文を、SQS SendMessageの
    // MessageBodyパラメータとして組み立てるVTL。MessageBodyはform-urlencodedパラメータの
    // 値であってJSON-in-JSONではないため、DynamoDB統合のような二重エスケープは不要——ただし
    // 実機検証の結果、API GatewayのVTLエンジンは`$util.urlEncode("...")`のような二重引用符の
    // 文字列リテラル内で`\"`によるエスケープをサポートしない(パースエラー"Unable to transform
    // request"になることをtest-invoke-methodで確認済み)。回避策として、`#set($q = '"')`で
    // 二重引用符1文字を単一引用符リテラル(エスケープ不要)に退避し、`${q}`という変数参照として
    // 埋め込むことでパーサーの引用符衝突そのものを避けている(docs/adr/0006)。
    const sqsIntegration = (commandJsonFragment: string) =>
      new apigateway.AwsIntegration({
        service: "sqs",
        // SQSクラシック(Query プロトコル)エンドポイントの形。QueueUrlをform paramとして
        // 渡す必要はなく、pathにアカウントID+キュー名を埋め込む。
        path: `${cdk.Aws.ACCOUNT_ID}/${commandQueue.queueName}`,
        integrationHttpMethod: "POST",
        options: {
          credentialsRole: commandApiSqsRole,
          passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
          requestParameters: {
            "integration.request.header.Content-Type": `'application/x-www-form-urlencoded'`,
          },
          requestTemplates: {
            // #set行はVTLディレクティブとして改行で終端する必要があるが、それ以外の
            // フォームフィールド(Action=.../&MessageGroupId=...等)の間に改行を挟むと、
            // 直前フィールドの値に改行文字が混入してSQS側の値マッチングが壊れる
            // (実機検証で発見——"Action=SendMessage\n"が"SendMessage"と一致せず、
            // SQSが"Version is missing"という無関係なエラーを返した。docs/adr/0006)。
            // そのため#set行の直後にだけ改行を残し、残りは1行で連結する。
            "application/json": [
              "#set($q = '\"')\n",
              "Action=SendMessage",
              "&MessageGroupId=$util.urlEncode($input.params('accountId'))",
              "&MessageDeduplicationId=$util.urlEncode($input.params().header.get('Idempotency-Key'))",
              `&MessageBody=$util.urlEncode("{\${q}account_id\${q}:\${q}$input.params('accountId')\${q},\${q}command\${q}:${commandJsonFragment}}")`,
            ].join(""),
          },
          // SQSのSendMessageレスポンスはXML(Queryプロトコル)であり、そこからMessageIdを
          // パースしようとはせず、200を202に読み替えて固定のacceptedボディを返す。selectionPattern
          // を指定し、SQS側の非2xx(例:MessageDeduplicationId不足等)を誤って202とみなさない
          // ようにする(実機検証でこの誤りを検出——パターン未指定のエントリはデフォルトの
          // catch-allとして扱われ、SQSの400も202に化けていた)。
          integrationResponses: [
            {
              statusCode: "202",
              selectionPattern: "2\\d{2}",
              responseTemplates: {
                "application/json": `{"accountId": "$input.params('accountId')", "status": "accepted"}`,
              },
            },
            {
              statusCode: "502",
              responseTemplates: {
                "application/json": `{"message": "failed to enqueue command"}`,
              },
            },
          ],
        },
      });

    const openCommandJson = `{\${q}Open\${q}:{\${q}owner_id\${q}:\${q}$util.escapeJavaScript($input.path('$.owner_id'))\${q},\${q}initial_balance\${q}:\${q}$util.escapeJavaScript($input.path('$.initial_balance'))\${q}}}`;
    const depositCommandJson = `{\${q}Deposit\${q}:{\${q}amount\${q}:\${q}$util.escapeJavaScript($input.path('$.amount'))\${q}}}`;
    const withdrawCommandJson = `{\${q}Withdraw\${q}:{\${q}amount\${q}:\${q}$util.escapeJavaScript($input.path('$.amount'))\${q}}}`;
    const freezeCommandJson = `{\${q}Freeze\${q}:{\${q}reason\${q}:\${q}$util.escapeJavaScript($input.path('$.reason'))\${q}}}`;
    // Unfreeze/CloseはCommandのユニットバリアントであり、serdeのデフォルト外部タグ付け表現
    // では素のJSON文字列になる(account.rsにtag属性なし。{"Unfreeze":{}}ではない)。
    const unfreezeCommandJson = `\${q}Unfreeze\${q}`;
    const closeCommandJson = `\${q}Close\${q}`;

    const requireIdempotencyKey = {
      "method.request.header.Idempotency-Key": true,
    };

    const commandAccountsResource = commandApi.root.addResource("accounts");
    const commandAccountResource = commandAccountsResource.addResource("{accountId}");

    // クライアントがUUIDを生成し、PUTで口座IDを指定して開設する(docs/adr/0006) —
    // AccountCommandEnvelopeがOpenを含む全コマンドでaccount_idを事前に要求する設計と一致し、
    // タイムアウト後の再送でも同じIDを使い回せる(べき等)。
    commandAccountResource.addMethod("PUT", sqsIntegration(openCommandJson), {
      requestValidator: commandRequestValidator,
      requestParameters: requireIdempotencyKey,
      requestModels: { "application/json": openModel },
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
    });

    commandAccountResource.addResource("deposits").addMethod("POST", sqsIntegration(depositCommandJson), {
      requestValidator: commandRequestValidator,
      requestParameters: requireIdempotencyKey,
      requestModels: { "application/json": amountModel },
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
    });

    commandAccountResource.addResource("withdrawals").addMethod("POST", sqsIntegration(withdrawCommandJson), {
      requestValidator: commandRequestValidator,
      requestParameters: requireIdempotencyKey,
      requestModels: { "application/json": amountModel },
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
    });

    commandAccountResource.addResource("freeze").addMethod("POST", sqsIntegration(freezeCommandJson), {
      requestValidator: commandRequestValidator,
      requestParameters: requireIdempotencyKey,
      requestModels: { "application/json": freezeModel },
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
    });

    commandAccountResource.addResource("unfreeze").addMethod("POST", sqsIntegration(unfreezeCommandJson), {
      requestValidator: commandParamsOnlyValidator,
      requestParameters: requireIdempotencyKey,
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
    });

    commandAccountResource.addResource("close").addMethod("POST", sqsIntegration(closeCommandJson), {
      requestValidator: commandParamsOnlyValidator,
      requestParameters: requireIdempotencyKey,
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
    });

    // ==========================================================================
    // Transfer service(docs/adr/0010) — 口座間送金のサガ(オーケストレーション)。
    //
    // account-service/query-serviceには一切変更を加えない(EventEnvelopeへのcorrelation_id
    // 追加を除く。上記のAccountDomainEventSchemaのcorrelation_idプロパティ参照)。
    // account-serviceへのコマンド発行はコマンドAPI(VTL)を経由せず、commandQueueへ直接
    // SendMessageする(docs/adr/0010決定1・決定6——新しいVTLを実機検証なしに追加するリスクを
    // 避けるため)。
    // ==========================================================================

    // --- [Transfer service所有] サガ状態(DynamoDB) ----------------------------
    // Query serviceと同じ技術選択だが理由は別(docs/adr/0010決定2): サガの状態更新は常に
    // 「1つのtransferIdにつき1アイテム」の読み書きで完結し、リレーショナル・トランザクション
    // 機構は不要なため。
    const transferSagaTable = new dynamodb.Table(this, "TransferSagaTable", {
      tableName: "moneta-transfer-sagas",
      partitionKey: { name: "transferId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // PoCスタックのため自由に壊せるようにする(他のリソースと同じ方針)。省略すると
      // RemovalPolicy.RETAINになり、変更セットのロールバック時にも
      // 削除されない——実際にこれが原因で、スキーマ移行失敗によるロールバック後の再デプロイが
      // 「moneta-transfer-sagasは既に存在する」で失敗した。
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // 顧客向け状態照会(docs/adr/0012決定1)のため、transfer-status-projectorへ配信する。
      // NEW_IMAGEのみで足りる(更新前の値を見る必要がない)。
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    // --- [Transfer service所有] 口座名義インデックス(DynamoDB、docs/adr/0011) ---
    // 振替(同一名義間)/振込(名義不一致)の判定に使う accountId→ownerId のインデックス。
    // query-serviceのAccountViewTableとは別に持つ(理由はowner_projector.rsのコメント参照:
    // 名義は`Opened`一度きりで不変なので、洗い替え方式の投影とは相性が悪い)。
    const transferAccountOwnersTable = new dynamodb.Table(this, "TransferAccountOwnersTable", {
      tableName: "moneta-transfer-account-owners",
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- [Transfer service所有] 送金受付のSQS FIFOキュー -----------------------
    // account-serviceのcommandQueueと同じFIFO+DLQの形だが、API Gatewayは経由しない
    // (docs/adr/0010決定6)。呼び出し元は`aws sqs send-message`等で
    // `{"transfer_id","from_account_id","to_account_id","amount"}`をMessageBodyとして
    // 直接送る。
    const transferCommandDlq = new sqs.Queue(this, "TransferCommandDlq", {
      queueName: "moneta-transfer-commands.fifo",
      fifo: true,
    });
    const transferCommandQueue = new sqs.Queue(this, "TransferCommandQueue", {
      queueName: "moneta-transfer-commands-main.fifo",
      fifo: true,
      contentBasedDeduplication: false,
      deadLetterQueue: {
        queue: transferCommandDlq,
        maxReceiveCount: MAX_RECEIVE_COUNT,
      },
    });

    // --- [Transfer service所有] transfer-command-intake: 送金開始の受付 --------
    const transferCommandIntakeFn = new lambda.Function(this, "TransferCommandIntakeFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("transfer-service", "transfer-command-intake"),
      environment: {
        SAGA_TABLE_NAME: transferSagaTable.tableName,
        OWNER_TABLE_NAME: transferAccountOwnersTable.tableName,
        ACCOUNT_COMMAND_QUEUE_URL: commandQueue.queueUrl,
      },
    });
    transferCommandIntakeFn.addEventSource(
      new SqsEventSource(transferCommandQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );
    transferSagaTable.grantReadWriteData(transferCommandIntakeFn);
    transferAccountOwnersTable.grantReadData(transferCommandIntakeFn);
    commandQueue.grantSendMessages(transferCommandIntakeFn);

    // --- [Transfer service所有] transfer-saga-step: 補償トリガーの観測とサガ進行 ---
    const transferSagaStepFn = new lambda.Function(this, "TransferSagaStepFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("transfer-service", "transfer-saga-step"),
      environment: {
        SAGA_TABLE_NAME: transferSagaTable.tableName,
        ACCOUNT_COMMAND_QUEUE_URL: commandQueue.queueUrl,
      },
    });
    transferSagaTable.grantReadWriteData(transferSagaStepFn);
    commandQueue.grantSendMessages(transferSagaStepFn);

    // --- [Transfer service所有] EventBridge Rule(補償トリガーの観測) ----------
    // account-serviceが発行したイベントのうち、correlation_idを持つもの(=transfer-service
    // が発行したコマンドへの応答)だけを購読する。account.event.*かaccount.rejection.*かを
    // detail-typeで区別する必要はない(saga_step.rsが`kind`フィールドで判別する)——ADR-0010
    // 起草時の監査で判明した通り、却下も既に`account.rejection.*`としてEventBridgeへ
    // 発行されている(docs/adr/0002決定7)。correlation_idを持つイベントはtransfer-serviceが
    // 発行したコマンドの結果に限られる(顧客の通常操作はこのフィールドを付与しない)ため、
    // 存在チェックだけで十分に絞り込める。
    new events.Rule(this, "TransferSagaObservationRule", {
      eventBus: domainEventBus,
      eventPattern: {
        source: [EVENT_SOURCE],
        detail: { correlation_id: [{ exists: true }] },
      },
      targets: [new targets.LambdaFunction(transferSagaStepFn)],
    });

    // --- [Transfer service所有] transfer-owner-projector: 口座名義インデックスの投影 ---
    // docs/adr/0011。`account.event.Opened`だけを購読する(名義は不変なのでOpened以外は
    // 無関係——query-serviceのAccountQueryProjectorFunctionのようにaccount.event.*全体を
    // 購読する必要はない)。
    const transferOwnerProjectorFn = new lambda.Function(this, "TransferOwnerProjectorFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("transfer-service", "transfer-owner-projector"),
      environment: {
        OWNER_TABLE_NAME: transferAccountOwnersTable.tableName,
      },
    });
    transferAccountOwnersTable.grantWriteData(transferOwnerProjectorFn);

    new events.Rule(this, "TransferOwnerObservationRule", {
      eventBus: domainEventBus,
      eventPattern: {
        source: [EVENT_SOURCE],
        detailType: ["account.event.Opened"],
      },
      targets: [new targets.LambdaFunction(transferOwnerProjectorFn)],
    });

    // ==========================================================================
    // Transfer serviceの顧客向け入口(docs/adr/0012) — [Transfer service所有]
    //
    // 決定1: 送金状態の読み取りモデル(TransferStatusView、DynamoDB Streams駆動)
    // ==========================================================================

    // TransferSagaTable(書き込み専用、CAS)を顧客向けAPIに直接晒さず、専用のビューを新設する。
    // オペレーション用ストアと顧客向け契約のライフサイクルを分離するため(決定1却下理由)。
    const transferStatusViewTable = new dynamodb.Table(this, "TransferStatusViewTable", {
      tableName: "moneta-transfer-status-view",
      partitionKey: { name: "transferId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const transferStatusProjectorDlq = new sqs.Queue(this, "TransferStatusProjectorDlq");

    const transferStatusProjectorFn = new lambda.Function(this, "TransferStatusProjectorFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("transfer-service", "transfer-status-projector"),
      environment: {
        STATUS_VIEW_TABLE_NAME: transferStatusViewTable.tableName,
      },
    });
    transferStatusViewTable.grantWriteData(transferStatusProjectorFn);

    transferStatusProjectorFn.addEventSource(
      new DynamoEventSource(transferSagaTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        retryAttempts: 3,
        reportBatchItemFailures: true,
        onFailure: new SqsDestination(transferStatusProjectorDlq),
      }),
    );

    // --- 送金状態照会API: API Gateway REST API + DynamoDB直接統合 --------------
    // account-serviceのAccountQueryApi(GetItem直接統合、決定1・[[0004]])と同じ思想。
    const transferQueryApiDynamoRole = new iam.Role(this, "TransferQueryApiDynamoRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });
    transferQueryApiDynamoRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [transferStatusViewTable.tableArn],
      }),
    );

    const transferQueryApi = new apigateway.RestApi(this, "TransferQueryApi", {
      restApiName: "moneta-transfer-query-api",
      deployOptions: { stageName: "prod" },
    });

    const getTransferIntegration = new apigateway.AwsIntegration({
      service: "dynamodb",
      action: "GetItem",
      options: {
        credentialsRole: transferQueryApiDynamoRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          "application/json": JSON.stringify({
            TableName: transferStatusViewTable.tableName,
            Key: {
              transferId: { S: "$input.params('transferId')" },
            },
          }),
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              // account-serviceのGetAccountIntegrationと同じ404変換パターン(決定1)。
              // TransferStatusViewの各属性をそのままJSONオブジェクトとして組み立てる
              // (accountViewTableのようなview属性への集約はしていないため、フィールドごと)。
              "application/json": [
                '#if($input.path("$.Item") == "")',
                "#set($context.responseOverride.status = 404)",
                '{"message": "transfer not found"}',
                "#else",
                "{",
                '"transferId":"$input.path("$.Item.transferId.S")",',
                '"fromAccountId":"$input.path("$.Item.fromAccountId.S")",',
                '"toAccountId":"$input.path("$.Item.toAccountId.S")",',
                '"amount":"$input.path("$.Item.amount.S")",',
                '"kind":"$input.path("$.Item.kind.S")",',
                '"state":"$input.path("$.Item.state.S")",',
                '"updatedAt":"$input.path("$.Item.updatedAt.S")"',
                "}",
                "#end",
              ].join("\n"),
            },
          },
        ],
      },
    });

    const transfersResource = transferQueryApi.root.addResource("transfers");
    const transferResource = transfersResource.addResource("{transferId}");
    transferResource.addMethod("GET", getTransferIntegration, {
      methodResponses: [{ statusCode: "200" }, { statusCode: "404" }],
    });

    // --- 送金受付API: API Gateway REST API + SQS直接統合(決定2〜4) ------------
    // account-serviceのAccountCommandApiと同じLambdaレスVTLパターン(決定2)。
    const transferCommandApiSqsRole = new iam.Role(this, "TransferCommandApiSqsRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });
    transferCommandApiSqsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [transferCommandQueue.queueArn],
      }),
    );

    const transferCommandApi = new apigateway.RestApi(this, "TransferCommandApi", {
      restApiName: "moneta-transfer-command-api",
      deployOptions: { stageName: "prod" },
    });

    // account-serviceのCommandRequestValidator/CommandParamsOnlyValidatorと同じ2段構え。
    // ただしIdempotency-Keyヘッダーは要求しない(決定3: transferIdとアクション名の組がすでに
    // 一意な冪等性キーになるため)。
    const transferCommandRequestValidator = new apigateway.RequestValidator(this, "TransferCommandRequestValidator", {
      restApi: transferCommandApi,
      validateRequestBody: true,
      validateRequestParameters: true,
    });
    const transferCommandParamsOnlyValidator = new apigateway.RequestValidator(
      this,
      "TransferCommandParamsOnlyValidator",
      {
        restApi: transferCommandApi,
        validateRequestBody: false,
        validateRequestParameters: true,
      },
    );

    const accountIdRefSchema: apigateway.JsonSchema = {
      type: apigateway.JsonSchemaType.STRING,
      minLength: 1,
    };

    const startTransferModel = transferCommandApi.addModel("StartTransferModel", {
      contentType: "application/json",
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ["from_account_id", "to_account_id", "amount"],
        properties: { from_account_id: accountIdRefSchema, to_account_id: accountIdRefSchema, amount: decimalStringSchema },
        additionalProperties: false,
      },
    });
    const recallTransferModel = transferCommandApi.addModel("RecallTransferModel", {
      contentType: "application/json",
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ["original_transfer_id"],
        properties: { original_transfer_id: accountIdRefSchema },
        additionalProperties: false,
      },
    });

    // `TransferCommand`(command_intake.rs)が期待するJSON本文を組み立てるVTL。
    // account-serviceのsqsIntegrationと同じ二重引用符エスケープ回避策(`$q`変数、決定2で
    // 再利用を確認する対象)を使う。MessageGroupId/MessageDeduplicationIdはどちらも
    // パスパラメータの`transferId`から導出する——`{transferId}-{action}`という固定サフィックス
    // 付き文字列がそのまま冪等性キーになる(決定3、Idempotency-Keyヘッダー不要)。
    const transferSqsIntegration = (transferCommandJsonFragment: string, dedupSuffix: string) =>
      new apigateway.AwsIntegration({
        service: "sqs",
        path: `${cdk.Aws.ACCOUNT_ID}/${transferCommandQueue.queueName}`,
        integrationHttpMethod: "POST",
        options: {
          credentialsRole: transferCommandApiSqsRole,
          passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
          requestParameters: {
            "integration.request.header.Content-Type": `'application/x-www-form-urlencoded'`,
          },
          requestTemplates: {
            "application/json": [
              "#set($q = '\"')\n",
              "Action=SendMessage",
              "&MessageGroupId=$util.urlEncode($input.params('transferId'))",
              `&MessageDeduplicationId=$util.urlEncode($input.params('transferId'))-${dedupSuffix}`,
              `&MessageBody=$util.urlEncode("${transferCommandJsonFragment}")`,
            ].join(""),
          },
          integrationResponses: [
            {
              statusCode: "202",
              selectionPattern: "2\\d{2}",
              responseTemplates: {
                "application/json": `{"transferId": "$input.params('transferId')", "status": "accepted"}`,
              },
            },
            {
              statusCode: "502",
              responseTemplates: {
                "application/json": `{"message": "failed to enqueue command"}`,
              },
            },
          ],
        },
      });

    const startCommandJson = `{\${q}Start\${q}:{\${q}transfer_id\${q}:\${q}$input.params('transferId')\${q},\${q}from_account_id\${q}:\${q}$util.escapeJavaScript($input.path('$.from_account_id'))\${q},\${q}to_account_id\${q}:\${q}$util.escapeJavaScript($input.path('$.to_account_id'))\${q},\${q}amount\${q}:\${q}$util.escapeJavaScript($input.path('$.amount'))\${q}}}`;
    const confirmCommandJson = `{\${q}Confirm\${q}:{\${q}transfer_id\${q}:\${q}$input.params('transferId')\${q}}}`;
    const cancelCommandJson = `{\${q}Cancel\${q}:{\${q}transfer_id\${q}:\${q}$input.params('transferId')\${q}}}`;
    const recallCommandJson = `{\${q}Recall\${q}:{\${q}transfer_id\${q}:\${q}$input.params('transferId')\${q},\${q}original_transfer_id\${q}:\${q}$util.escapeJavaScript($input.path('$.original_transfer_id'))\${q}}}`;

    const transferCommandTransfersResource = transferCommandApi.root.addResource("transfers");
    const transferCommandTransferResource = transferCommandTransfersResource.addResource("{transferId}");

    // クライアントが新しいtransferIdを生成し、PUTで指定して開始する(決定4、account-service
    // のPUT /accounts/{accountId}と同じ意味論)。
    transferCommandTransferResource.addMethod("PUT", transferSqsIntegration(startCommandJson, "start"), {
      requestValidator: transferCommandRequestValidator,
      requestModels: { "application/json": startTransferModel },
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
    });

    transferCommandTransferResource
      .addResource("confirm")
      .addMethod("POST", transferSqsIntegration(confirmCommandJson, "confirm"), {
        requestValidator: transferCommandParamsOnlyValidator,
        methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
      });

    transferCommandTransferResource
      .addResource("cancel")
      .addMethod("POST", transferSqsIntegration(cancelCommandJson, "cancel"), {
        requestValidator: transferCommandParamsOnlyValidator,
        methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
      });

    // 組戻し。パスの{transferId}は組戻し自身の新しいサガID、取消対象はbodyのoriginal_transfer_id
    // (決定4: 「新しいリソースをこのIDで作る」というPUTの意味論をStartと揃える)。
    transferCommandTransferResource
      .addResource("recall")
      .addMethod("PUT", transferSqsIntegration(recallCommandJson, "recall"), {
        requestValidator: transferCommandRequestValidator,
        requestModels: { "application/json": recallTransferModel },
        methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
      });

    // ==========================================================================
    // Web UIホスティング + CloudFrontによるオリジン統合(docs/adr/0007)
    //
    // queryApi/commandApiはどちらもリソースパスが/accounts/{accountId}から始まる
    // (GETが照会、PUTがOpen)。CloudFrontのcache behaviorはHTTPメソッドではなくパスでしか
    // 振り分けられないため、単純な/accounts/*という1つのbehaviorではこの2つのAPIを区別
    // できない。ブラウザから見えるパスに/query-api・/command-apiというprefixを与え、
    // CloudFront Function(viewer-request)でprefixを剥がしてから各オリジンへ転送すること
    // で区別する。結果としてWeb UIは常に単一オリジン(CloudFrontドメイン)だけを叩くこと
    // になり、CORSプリフライト自体が発生しない(同一オリジンのリクエストはブラウザのCORS
    // 機構の対象外——Idempotency-Keyのようなカスタムヘッダーを使うPUT/POSTも同様)。
    // 既存のqueryApi/commandApiの実装(VTL含む)は無改修。
    // ==========================================================================

    const webUiBucket = new s3.Bucket(this, "WebUiBucket", {
      // CDKのs3.Bucketはデフォルトでは PublicAccessBlockConfiguration をテンプレートに
      // 出力しない(アカウントレベルの既定に委ねる)。CloudFront(OAC)経由でのみ読み取り
      // 可能にする意図を明示するため、バケット側でも明示的にBLOCK_ALLにする。
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // PoCスタックのため自由に壊せるようにする(他のリソースと同じ方針)。
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const queryApiPrefixFunction = new cloudfront.Function(this, "QueryApiPrefixFunction", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          "function handler(event) {",
          "  var request = event.request;",
          '  request.uri = request.uri.replace(/^\\/query-api/, "") || "/";',
          "  return request;",
          "}",
        ].join("\n"),
      ),
    });

    const commandApiPrefixFunction = new cloudfront.Function(this, "CommandApiPrefixFunction", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          "function handler(event) {",
          "  var request = event.request;",
          '  request.uri = request.uri.replace(/^\\/command-api/, "") || "/";',
          "  return request;",
          "}",
        ].join("\n"),
      ),
    });

    // Transfer serviceの顧客向けAPI(docs/adr/0012決定5)。account-serviceのものとは別プレフィックス
    // にすることで、CloudFront Function側の書き換えロジックもAPI Gateway側のリソースツリーも
    // account-serviceのものと独立に保つ。
    const transferQueryApiPrefixFunction = new cloudfront.Function(this, "TransferQueryApiPrefixFunction", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          "function handler(event) {",
          "  var request = event.request;",
          '  request.uri = request.uri.replace(/^\\/transfer-query-api/, "") || "/";',
          "  return request;",
          "}",
        ].join("\n"),
      ),
    });

    const transferCommandApiPrefixFunction = new cloudfront.Function(this, "TransferCommandApiPrefixFunction", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          "function handler(event) {",
          "  var request = event.request;",
          '  request.uri = request.uri.replace(/^\\/transfer-command-api/, "") || "/";',
          "  return request;",
          "}",
        ].join("\n"),
      ),
    });

    // CloudFrontはデフォルトで任意ヘッダーをオリジンへ転送しないため、Idempotency-Key
    // (ADR-0006決定3)を明示的に転送する。
    const commandApiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, "CommandApiOriginRequestPolicy", {
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList("Idempotency-Key", "Content-Type"),
    });

    const webUiDistribution = new cloudfront.Distribution(this, "WebUiDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webUiBucket),
      },
      additionalBehaviors: {
        // 結果整合性のあるレスポンスをCDNにキャッシュさせないため、API系はどちらも
        // CACHING_DISABLED(ADR-0007)。
        "/query-api/*": {
          origin: new origins.RestApiOrigin(queryApi),
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          functionAssociations: [
            { function: queryApiPrefixFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        "/command-api/*": {
          origin: new origins.RestApiOrigin(commandApi),
          // デフォルト(ALLOW_GET_HEAD)だとPUT/POSTが403になる(実機検証で発見)。書き込み
          // コマンドはPUT(Open)とPOST(Deposit等)のため明示的に全メソッドを許可する。
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: commandApiOriginRequestPolicy,
          functionAssociations: [
            { function: commandApiPrefixFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        "/transfer-query-api/*": {
          origin: new origins.RestApiOrigin(transferQueryApi),
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          functionAssociations: [
            { function: transferQueryApiPrefixFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        "/transfer-command-api/*": {
          origin: new origins.RestApiOrigin(transferCommandApi),
          // account-serviceのcommand-apiと同じ理由(デフォルトのALLOW_GET_HEADだとPUT/POSTが
          // 403になる)。
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          functionAssociations: [
            { function: transferCommandApiPrefixFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
      defaultRootObject: "index.html",
    });

    // web-ui/distを事前ビルドしておく必要がある(web-ui/README.md参照)。Rust Lambda群の
    // ようなDockerバンドリングは不要と判断した——Node/npmのビルドにはLambda実行時との
    // glibcバージョン互換性問題が無いため。
    new s3deploy.BucketDeployment(this, "WebUiDeployment", {
      sources: [s3deploy.Source.asset(path.join(repoRoot, "web-ui", "dist"))],
      destinationBucket: webUiBucket,
      distribution: webUiDistribution,
      distributionPaths: ["/*"],
    });

    // --- Outputs ---------------------------------------------------------------
    new cdk.CfnOutput(this, "AccountsTableName", { value: accountsTable.tableName });
    new cdk.CfnOutput(this, "AccountEventsTableName", { value: accountEventsTable.tableName });
    new cdk.CfnOutput(this, "ProcessedMessagesTableName", { value: processedMessagesTable.tableName });
    new cdk.CfnOutput(this, "CommandQueueUrl", { value: commandQueue.queueUrl });
    new cdk.CfnOutput(this, "DeadLetterQueueUrl", { value: deadLetterQueue.queueUrl });
    new cdk.CfnOutput(this, "AccountServiceFunctionName", { value: fn.functionName });
    new cdk.CfnOutput(this, "LambdaExecutionRoleArn", { value: fn.role!.roleArn });
    new cdk.CfnOutput(this, "OutboxProjectorFunctionName", { value: outboxProjectorFn.functionName });
    new cdk.CfnOutput(this, "OutboxProjectorExecutionRoleArn", { value: outboxProjectorFn.role!.roleArn });
    new cdk.CfnOutput(this, "OutboxProjectorDlqUrl", { value: outboxProjectorDlq.queueUrl });
    new cdk.CfnOutput(this, "DomainEventBusName", { value: domainEventBus.eventBusName });
    new cdk.CfnOutput(this, "AccountViewTableName", { value: accountViewTable.tableName });
    new cdk.CfnOutput(this, "AccountHistoryTableName", { value: accountHistoryTable.tableName });
    new cdk.CfnOutput(this, "QueryProjectorFunctionName", { value: queryProjectorFn.functionName });
    new cdk.CfnOutput(this, "QueryApiUrl", { value: queryApi.url });
    new cdk.CfnOutput(this, "CommandApiUrl", { value: commandApi.url });
    new cdk.CfnOutput(this, "WebUiUrl", { value: `https://${webUiDistribution.domainName}` });
    new cdk.CfnOutput(this, "TransferSagaTableName", { value: transferSagaTable.tableName });
    new cdk.CfnOutput(this, "TransferAccountOwnersTableName", { value: transferAccountOwnersTable.tableName });
    new cdk.CfnOutput(this, "TransferCommandQueueUrl", { value: transferCommandQueue.queueUrl });
    new cdk.CfnOutput(this, "TransferCommandDeadLetterQueueUrl", { value: transferCommandDlq.queueUrl });
    new cdk.CfnOutput(this, "TransferCommandIntakeFunctionName", { value: transferCommandIntakeFn.functionName });
    new cdk.CfnOutput(this, "TransferSagaStepFunctionName", { value: transferSagaStepFn.functionName });
    new cdk.CfnOutput(this, "TransferOwnerProjectorFunctionName", { value: transferOwnerProjectorFn.functionName });
    new cdk.CfnOutput(this, "TransferStatusViewTableName", { value: transferStatusViewTable.tableName });
    new cdk.CfnOutput(this, "TransferStatusProjectorFunctionName", { value: transferStatusProjectorFn.functionName });
    new cdk.CfnOutput(this, "TransferQueryApiUrl", { value: transferQueryApi.url });
    new cdk.CfnOutput(this, "TransferCommandApiUrl", { value: transferCommandApi.url });
  }
}

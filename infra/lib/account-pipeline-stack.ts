import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as customResources from "aws-cdk-lib/custom-resources";
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
// admin role (dsql:DbConnectAdmin, reserved for schema setup -- see the
// AccountSchemaMigratorFunction custom resource below, docs/adr/0005).
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
    // ここでのpatternは「小数として解釈できる文字列か」という構造検証であり、
    // 「正の値か」等の業務ルール(DomainError::InvalidAmount)には踏み込まない(ADR-0002の境界)。
    const decimalStringSchema: apigateway.JsonSchema = {
      type: apigateway.JsonSchemaType.STRING,
      pattern: "^-?\\d+(\\.\\d+)?$",
    };

    const openModel = commandApi.addModel("OpenCommandModel", {
      contentType: "application/json",
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ["initial_balance"],
        properties: { initial_balance: decimalStringSchema },
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

    const openCommandJson = `{\${q}Open\${q}:{\${q}initial_balance\${q}:\${q}$util.escapeJavaScript($input.path('$.initial_balance'))\${q}}}`;
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

    // --- スキーマ適用(CDK Custom Resource、docs/adr/0005) ----------------------
    // かつては`infra/scripts/apply-schema.sh`をデプロイ後に手動実行する運用だったが、
    // outbox relay用のロール追加をスクリプト更新し忘れたまま実AWSにデプロイし、DSQLへの接続が
    // access deniedになる不具合を実際に起こした。デプロイ自体にスキーマ適用を組み込み、
    // 手動手順を無くす。CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTSは
    // 公式ドキュメントでべき等性を確認済み(schema.sql参照)。CREATE ROLE・AWS IAM GRANTは
    // べき等な構文が無いため、Lambda側で「既に存在する」系のエラーを捕捉して無視する。
    const schemaMigratorFn = new lambda.Function(this, "AccountSchemaMigratorFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("account-schema-migrator"),
    });
    schemaMigratorFn.addToRolePolicy(
      new iam.PolicyStatement({
        // 通常のdsql:DbConnectとは別のIAMアクション(admin接続専用)。
        actions: ["dsql:DbConnectAdmin"],
        resources: [cluster.attrResourceArn],
      }),
    );

    const schemaMigrationProvider = new customResources.Provider(this, "AccountSchemaMigrationProvider", {
      onEventHandler: schemaMigratorFn,
    });

    // schema.sqlの内容またはグラント対象ロールの一覧が変わるたびに、CloudFormationが
    // ResourceProperties変更とみなしUpdateイベントを発火させる(=再適用される)ようにする
    // ためだけのトリガー値。値そのものにLambda側では意味を持たせていない。
    const schemaSqlPath = path.join(repoRoot, "crates", "account-service", "schema.sql");
    const lambdaRoleArnsNeedingDsqlAccess = [fn.role!.roleArn, outboxRelayFn.role!.roleArn];
    const migrationTrigger = crypto
      .createHash("sha256")
      .update(fs.readFileSync(schemaSqlPath, "utf8"))
      .update(lambdaRoleArnsNeedingDsqlAccess.join(","))
      .digest("hex");

    const schemaMigration = new cdk.CustomResource(this, "AccountSchemaMigration", {
      serviceToken: schemaMigrationProvider.serviceToken,
      properties: {
        ClusterEndpoint: cluster.attrEndpoint,
        LambdaRoleArns: lambdaRoleArnsNeedingDsqlAccess,
        Trigger: migrationTrigger,
      },
    });

    // account-serviceとoutbox relayは、スキーマ適用・IAM GRANTが完了して初めてDSQLへの接続に
    // 成功する。fn/outboxRelayFnのコンストラクト全体(CDKが自動生成するIAM Roleを含む)に
    // 明示的な依存を張ろうとすると、そのRoleのARNをschemaMigration自身がLambdaRoleArnsとして
    // 参照しているため循環依存になる(試して実際に検出された)。そのため明示的な順序付けは
    // 行わず、同時にデプロイされてこの2つのLambdaが先に呼ばれた場合はADR-0002の分類通り
    // インフラ起因の失敗としてリトライに委ね、移行完了後に自然に解消させる。

    // --- Outputs ---------------------------------------------------------------
    new cdk.CfnOutput(this, "ClusterEndpoint", { value: cluster.attrEndpoint });
    new cdk.CfnOutput(this, "ClusterResourceArn", { value: cluster.attrResourceArn });
    new cdk.CfnOutput(this, "CommandQueueUrl", { value: commandQueue.queueUrl });
    new cdk.CfnOutput(this, "DeadLetterQueueUrl", { value: deadLetterQueue.queueUrl });
    new cdk.CfnOutput(this, "AccountServiceFunctionName", { value: fn.functionName });
    new cdk.CfnOutput(this, "LambdaExecutionRoleArn", { value: fn.role!.roleArn });
    new cdk.CfnOutput(this, "OutboxRelayFunctionName", { value: outboxRelayFn.functionName });
    new cdk.CfnOutput(this, "OutboxRelayExecutionRoleArn", { value: outboxRelayFn.role!.roleArn });
    new cdk.CfnOutput(this, "SchemaMigratorFunctionName", { value: schemaMigratorFn.functionName });
    new cdk.CfnOutput(this, "DomainEventBusName", { value: domainEventBus.eventBusName });
    new cdk.CfnOutput(this, "AccountViewTableName", { value: accountViewTable.tableName });
    new cdk.CfnOutput(this, "QueryProjectorFunctionName", { value: queryProjectorFn.functionName });
    new cdk.CfnOutput(this, "QueryApiUrl", { value: queryApi.url });
    new cdk.CfnOutput(this, "CommandApiUrl", { value: commandApi.url });
  }
}

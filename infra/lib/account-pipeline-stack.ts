import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
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

// docs/adr/0024: fee-service/points-serviceがdomainEventBusへ発行するイベントのsource。
// どちらもaccount-domainに依存しないため、account-serviceのようなSchema Registry登録は
// 行わない(スキーマの自己登録という契約はaccount-serviceの設計であり、この2サービスまで
// 一律に広げる必然性はない——スキーマレスなまま`detail.correlation_id`の存在チェックだけで
// 十分に絞り込める、TransferSagaObservationRuleの既存の設計を踏襲する)。
const FEE_EVENT_SOURCE = "fee-service";
const POINTS_EVENT_SOURCE = "points-service";

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

    // docs/adr/0002決定6・production-readiness-matrix.md O1: DLQの滞留数・最古メッセージの
    // 経過時間にCloudWatchアラームを張る。ADR自体は決定していたが、実装が伴っていなかった
    // (2026-08-10発見)。`maxReceiveCount`を低く抑えている設計(このファイル冒頭のコメント参照)
    // 上、DLQへの到達自体が「Lambda内3回リトライを使い切ってもなお解決しなかった、真に持続的な
    // インフラ起因の失敗」を意味するため、閾値は「1件でも見えたら発報」という保守的な設定にする。
    const addDlqAlarms = (id: string, queue: sqs.Queue) => {
      new cloudwatch.Alarm(this, `${id}MessagesVisibleAlarm`, {
        alarmName: `moneta-${queue.queueName}-messages-visible`,
        metric: queue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      new cloudwatch.Alarm(this, `${id}OldestMessageAgeAlarm`, {
        alarmName: `moneta-${queue.queueName}-oldest-message-age`,
        metric: queue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.minutes(5) }),
        // DLQに何かが滞留し続けている場合の経過時間の目安として1時間(ADRは具体的な閾値を
        // 決め打ちしていないため、保守的な初期値として採用する——実運用でチューニングする前提)。
        threshold: cdk.Duration.hours(1).toSeconds(),
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    };

    // --- SQS FIFO queue + DLQ -------------------------------------------------
    const deadLetterQueue = new sqs.Queue(this, "AccountCommandDlq", {
      queueName: "moneta-account-commands.fifo",
      fifo: true,
    });
    addDlqAlarms("AccountCommandDlq", deadLetterQueue);

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
    // account_eventsは追記専用(監査ログ、docs/production-readiness-matrix.md L3)。
    // `grantWriteData`はPutItemに加えUpdateItem/DeleteItem/BatchWriteItemも付与してしまい、
    // コメントが謳う「PutItemのみ」という意図と矛盾する過剰権限だった(2026-08-10発見)。
    // 必要なアクションだけを明示的に列挙する。
    accountEventsTable.grant(fn, "dynamodb:PutItem", "dynamodb:TransactWriteItems");
    // 冪等性ログも同じ理由で追記専用にする——同一メッセージIDの再処理はConditionalCheckFailed
    // で弾かれる設計であり(ADR-0002決定4)、既存項目のUpdate/Deleteは想定されていない。
    processedMessagesTable.grant(fn, "dynamodb:PutItem", "dynamodb:TransactWriteItems");

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
                // Deposit/Withdrawを起こした外部チャネル(docs/adr/0023)。correlation_idと
                // 同じ理由で必須にしない。
                channel: { type: "string" },
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

    // ==========================================================================
    // Auth service (docs/adr/0016) — Amazon Cognitoによる実認証。
    //
    // account-service/query-service/transfer-serviceのどのテーブルにも触れない
    // (crates/auth-serviceはaccount-domainにすら依存しない、[[0003]]のcrate境界の考え方の
    // 延長——認証はアカウントのドメインとは独立の関心事)。CognitoのLambdaトリガーから直接
    // domainEventBusへPutEventsする——account-serviceのようなDynamoDBアウトボックスは
    // 不要(トリガー呼び出し自体が真実源であり、二重書き込み問題が存在しないため)。
    // ==========================================================================

    const authPostConfirmationFn = new lambda.Function(this, "AuthPostConfirmationFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(10),
      code: rustLambdaCode("auth-service", "auth-post-confirmation"),
      environment: {
        POST_CONFIRMATION_EVENT_BUS_NAME: domainEventBus.eventBusName,
      },
    });
    domainEventBus.grantPutEventsTo(authPostConfirmationFn);

    const authPostAuthenticationFn = new lambda.Function(this, "AuthPostAuthenticationFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(10),
      code: rustLambdaCode("auth-service", "auth-post-authentication"),
      environment: {
        POST_AUTHENTICATION_EVENT_BUS_NAME: domainEventBus.eventBusName,
      },
    });
    domainEventBus.grantPutEventsTo(authPostAuthenticationFn);

    const authPreSignUpFn = new lambda.Function(this, "AuthPreSignUpFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(10),
      code: rustLambdaCode("auth-service", "auth-pre-signup"),
    });

    // メール確認(SESセットアップ)を要求しないセルフサインアップにする(docs/adr/0016決定1)。
    // PreSignUpトリガーが常にautoConfirmUser: trueを返すため、確認コード入力ステップが無い。
    const userPool = new cognito.UserPool(this, "CustomerUserPool", {
      userPoolName: "moneta-customers",
      selfSignUpEnabled: true,
      signInAliases: { username: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
      },
      // メール/電話番号を要求しないため、それらを使った復旧手段自体が存在しない。
      accountRecovery: cognito.AccountRecovery.NONE,
      lambdaTriggers: {
        preSignUp: authPreSignUpFn,
        postConfirmation: authPostConfirmationFn,
        postAuthentication: authPostAuthenticationFn,
      },
      // PoCスタックのため自由に壊せるようにする(他のリソースと同じ方針)。
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // SRPではなく単純なユーザー名+パスワード送信(docs/adr/0016決定1)——Amplifyの重いSRP
    // クライアントを新規依存に追加しない単純化。TLSに保護される前提のトレードオフ。
    const userPoolClient = userPool.addClient("CustomerUserPoolClient", {
      authFlows: { userPassword: true },
      generateSecret: false,
    });

    // 顧客向けAPIエンドポイント全てに認証を要求する(docs/adr/0016決定2)。CDKの
    // CognitoUserPoolsAuthorizerは1つのインスタンスを複数のRestApiへまたがってaddMethodで
    // 使うと"Cannot attach authorizer to two different rest APIs"で失敗する(実機ではなく
    // cdk synth時点で判明——CLAUDE.mdの「AWS/ライブラリの挙動は推測せず検証する」を地で行く形
    // になった)。同じuserPoolを指す別々のAuthorizerリソースを、RestApiごとに1つずつ持つ。
    const accountQueryAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "AccountQueryAuthorizer", {
      cognitoUserPools: [userPool],
    });
    const accountCommandAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "AccountCommandAuthorizer", {
      cognitoUserPools: [userPool],
    });
    const accountNumberQueryAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "AccountNumberQueryAuthorizer", {
      cognitoUserPools: [userPool],
    });
    const transferQueryAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "TransferQueryAuthorizer", {
      cognitoUserPools: [userPool],
    });
    const transferCommandAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "TransferCommandAuthorizer", {
      cognitoUserPools: [userPool],
    });
    // docs/adr/0025: PointsQueryApi専用。同じuserPoolを指す別々のAuthorizerが要る理由は上記の
    // コメントの通り。
    const pointsQueryAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "PointsQueryAuthorizer", {
      cognitoUserPools: [userPool],
    });

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
              // docs/adr/0027決定1: 404判定の次に、認証済みユーザー(sub)がこの口座の名義
              // (ownerId)と一致するかを見る——一致しなければ403(item単位の読み取り認可)。
              "application/json": [
                '#if($input.path("$.Item") == "")',
                "#set($context.responseOverride.status = 404)",
                '{"message": "account not found"}',
                '#elseif($input.path("$.Item.ownerId.S") != $context.authorizer.claims.sub)',
                "#set($context.responseOverride.status = 403)",
                '{"message": "forbidden"}',
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
      methodResponses: [{ statusCode: "200" }, { statusCode: "403" }, { statusCode: "404" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: accountQueryAuthorizer,
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
          // docs/adr/0027決定1: FilterExpressionでownerId不一致のアイテムを除外する。
          // Limit(50)はDynamoDB内部でFilterExpression適用前のキー一致件数に対してかかる
          // (AWS公式ドキュメントで確認済みの既知の挙動)が、同一accountId(パーティション)配下の
          // アイテムは全て同じownerIdを持つため、この境界ケースは実害がない
          // (「一部だけ絞り込まれて消える」ことが起こり得ない——全件一致か全件不一致かの二択)。
          "application/json": JSON.stringify({
            TableName: accountHistoryTable.tableName,
            KeyConditionExpression: "accountId = :accountId",
            FilterExpression: "ownerId = :ownerId",
            ExpressionAttributeValues: {
              ":accountId": { S: "$input.params('accountId')" },
              ":ownerId": { S: "$context.authorizer.claims.sub" },
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
              // カンマ区切りで連結してJSON配列を組み立てる。docs/adr/0027決定1: 実在する口座は
              // Event::Openedの分だけ必ず1件以上の履歴を持つ(history.rs)ため、フィルタ後0件は
              // 「他人の口座」(または未反映のeventual consistencyの窓)以外にありえず、404/403の
              // 判定に曖昧さは生じない。
              "application/json": [
                "#set($items = $input.path('$.Items'))",
                '#if($items.size() == 0)',
                "#set($context.responseOverride.status = 403)",
                '{"message": "forbidden"}',
                "#else",
                "[",
                "#foreach($item in $items)",
                "$item.entry.S#if($foreach.hasNext),#end",
                "#end",
                "]",
                "#end",
              ].join("\n"),
            },
          },
        ],
      },
    });

    const transactionsResource = accountResource.addResource("transactions");
    transactionsResource.addMethod("GET", listTransactionsIntegration, {
      methodResponses: [{ statusCode: "200" }, { statusCode: "403" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: accountQueryAuthorizer,
    });

    // --- [Query Service所有] 人間可読な口座番号(docs/adr/0015) -----------------
    // UUIDのaccountIdをそのまま顧客に入力させる代わりに、支店(3桁)+口座番号(7桁)という
    // 別名を発番して持つ。account.event.Openedだけを購読する専用の小さな投影
    // (owner_projector.rsと同型、docs/adr/0011)——AccountViewTableの「洗い替え」投影には
    // 相乗りしない(理由は同ファイルのコメント参照)。
    const accountNumbersTable = new dynamodb.Table(this, "AccountNumbersTable", {
      tableName: "moneta-account-numbers",
      partitionKey: { name: "accountNumber", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // accountId→口座番号の逆引き用(自分の口座番号を表示する画面向け)。テーブルが小さい
    // PoC規模なのでALL射影にし、branchCode/branchName/ownerNameも逆引き1回で取れるようにする。
    accountNumbersTable.addGlobalSecondaryIndex({
      indexName: "byAccountId",
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const accountNumberProjectorFn = new lambda.Function(this, "AccountNumberProjectorFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("query-service", "account-number-projector"),
      environment: {
        ACCOUNT_NUMBERS_TABLE_NAME: accountNumbersTable.tableName,
      },
    });
    accountNumbersTable.grantWriteData(accountNumberProjectorFn);

    new events.Rule(this, "AccountNumberObservationRule", {
      eventBus: domainEventBus,
      eventPattern: {
        source: [EVENT_SOURCE],
        detailType: ["account.event.Opened"],
      },
      targets: [new targets.LambdaFunction(accountNumberProjectorFn)],
    });

    // --- [Query Service所有] 口座番号照会API: API Gateway + DynamoDB直接統合 ---
    const accountNumberQueryApiDynamoRole = new iam.Role(this, "AccountNumberQueryApiDynamoRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });
    accountNumberQueryApiDynamoRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [accountNumbersTable.tableArn],
      }),
    );
    accountNumberQueryApiDynamoRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [`${accountNumbersTable.tableArn}/index/byAccountId`],
      }),
    );

    const accountNumberQueryApi = new apigateway.RestApi(this, "AccountNumberQueryApi", {
      restApiName: "moneta-account-number-query-api",
      deployOptions: { stageName: "prod" },
    });

    // 口座番号→口座(振込の宛先解決用)。getAccountIntegrationと同じGetItem+404変換パターン。
    const getAccountByNumberIntegration = new apigateway.AwsIntegration({
      service: "dynamodb",
      action: "GetItem",
      options: {
        credentialsRole: accountNumberQueryApiDynamoRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          "application/json": JSON.stringify({
            TableName: accountNumbersTable.tableName,
            Key: {
              accountNumber: { S: "$input.params('accountNumber')" },
            },
          }),
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              "application/json": [
                '#if($input.path("$.Item") == "")',
                "#set($context.responseOverride.status = 404)",
                '{"message": "account number not found"}',
                "#else",
                "{",
                '"accountId":"$input.path("$.Item.accountId.S")",',
                '"ownerName":"$input.path("$.Item.ownerName.S")",',
                '"accountNumber":"$input.path("$.Item.accountNumber.S")",',
                '"branchCode":"$input.path("$.Item.branchCode.S")",',
                '"branchName":"$input.path("$.Item.branchName.S")"',
                "}",
                "#end",
              ].join("\n"),
            },
          },
        ],
      },
    });

    const accountNumbersResource = accountNumberQueryApi.root.addResource("account-numbers");
    const accountNumberResource = accountNumbersResource.addResource("{accountNumber}");
    accountNumberResource.addMethod("GET", getAccountByNumberIntegration, {
      methodResponses: [{ statusCode: "200" }, { statusCode: "404" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: accountNumberQueryAuthorizer,
    });

    // 口座→口座番号(自分の口座番号を表示する画面向け)。byAccountId GSIへのQuery。
    // listTransactionsIntegrationと同じ#foreachパターンで単一件を取り出す(デプロイ後に
    // test-invoke-methodで実機検証すること、docs/adr/0006の教訓を踏まえる)。
    const getAccountNumberByAccountIntegration = new apigateway.AwsIntegration({
      service: "dynamodb",
      action: "Query",
      options: {
        credentialsRole: accountNumberQueryApiDynamoRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          "application/json": JSON.stringify({
            TableName: accountNumbersTable.tableName,
            IndexName: "byAccountId",
            KeyConditionExpression: "accountId = :accountId",
            ExpressionAttributeValues: {
              ":accountId": { S: "$input.params('accountId')" },
            },
            Limit: 1,
          }),
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              "application/json": [
                "#if($input.path('$.Items').size() == 0)",
                "#set($context.responseOverride.status = 404)",
                '{"message": "account number not found"}',
                "#else",
                "#foreach($item in $input.path('$.Items'))",
                "{",
                '"accountId":"$item.accountId.S",',
                '"ownerName":"$item.ownerName.S",',
                '"accountNumber":"$item.accountNumber.S",',
                '"branchCode":"$item.branchCode.S",',
                '"branchName":"$item.branchName.S"',
                "}",
                "#end",
                "#end",
              ].join("\n"),
            },
          },
        ],
      },
    });

    // account-numbers/{accountNumber}と同じAccountNumberQueryApi(=同じCloudFront prefix)配下に
    // 置く。queryApi(既存のAccountQueryApi)側のaccountResourceは再利用しない——このAPIは
    // account-service/query-serviceの境界とは独立な、口座番号専用の照会APIとして閉じておく
    // (docs/adr/0015)。
    const accountNumberAccountsResource = accountNumberQueryApi.root.addResource("accounts");
    const accountNumberByAccountResource = accountNumberAccountsResource.addResource("{accountId}").addResource("account-number");
    accountNumberByAccountResource.addMethod("GET", getAccountNumberByAccountIntegration, {
      methodResponses: [{ statusCode: "200" }, { statusCode: "404" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: accountNumberQueryAuthorizer,
    });

    // --- [Query Service所有] 本物の顧客-口座関係(docs/adr/0016決定4) ---------
    // 認証(Cognito)の導入により、ownerIdはもはや検証済みの識別子になった——[[0009]]決定2が
    // 「バックエンドに『顧客』という概念は一切追加しない…本物の顧客-口座関係が必要になれば
    // 見直す」としていたのをここで見直す。account.event.Openedだけを購読する専用の小さな
    // 投影(owner_projector.rs/account_number_projector.rsと同型)。
    const customerAccountsTable = new dynamodb.Table(this, "CustomerAccountsTable", {
      tableName: "moneta-customer-accounts",
      partitionKey: { name: "ownerId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // accountId→ownerIdの逆引き用(docs/adr/0027決定1)。AccountQueryProjectorFunctionが
    // Deposit/Freeze等、owner_idを運ばないイベントの処理時にownerIdを解決するために引く
    // ——AccountNumbersTableが既に持つ同名GSI([[0015]])と同じ「基本キーとは別目的の索引を
    // 足す」パターン。テーブルが小さいPoC規模なのでALL射影にする。
    customerAccountsTable.addGlobalSecondaryIndex({
      indexName: "byAccountId",
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const customerAccountsProjectorFn = new lambda.Function(this, "CustomerAccountsProjectorFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("query-service", "customer-accounts-projector"),
      environment: {
        CUSTOMER_ACCOUNTS_TABLE_NAME: customerAccountsTable.tableName,
      },
    });
    customerAccountsTable.grantWriteData(customerAccountsProjectorFn);

    // docs/adr/0027決定1: AccountQueryProjectorFunctionがownerId解決のためbyAccountId GSIを引く。
    // queryProjectorFnはcustomerAccountsTableより前で定義されているため、ここで
    // addEnvironment/grantを後付けする(customerAccountsProjectorFnへの上のgrantと同じ並び)。
    queryProjectorFn.addEnvironment("CUSTOMER_ACCOUNTS_TABLE_NAME", customerAccountsTable.tableName);
    customerAccountsTable.grantReadData(queryProjectorFn);

    new events.Rule(this, "CustomerAccountsObservationRule", {
      eventBus: domainEventBus,
      eventPattern: {
        source: [EVENT_SOURCE],
        detailType: ["account.event.Opened"],
      },
      targets: [new targets.LambdaFunction(customerAccountsProjectorFn)],
    });

    // GET /customers/me/accounts: ownerIdはリクエストパラメータではなくCognito JWTのsub
    // クレームから取る(docs/adr/0016決定4)——クライアントは他人のownerIdを指定できない。
    queryApiDynamoRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [customerAccountsTable.tableArn],
      }),
    );

    const listMyAccountsIntegration = new apigateway.AwsIntegration({
      service: "dynamodb",
      action: "Query",
      options: {
        credentialsRole: queryApiDynamoRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          "application/json": JSON.stringify({
            TableName: customerAccountsTable.tableName,
            KeyConditionExpression: "ownerId = :ownerId",
            ExpressionAttributeValues: {
              ":ownerId": { S: "$context.authorizer.claims.sub" },
            },
          }),
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              "application/json": [
                "#set($items = $input.path('$.Items'))",
                "[",
                "#foreach($item in $items)",
                '{"accountId":"$item.accountId.S","openedAt":"$item.openedAt.S"}#if($foreach.hasNext),#end',
                "#end",
                "]",
              ].join("\n"),
            },
          },
        ],
      },
    });

    const myAccountsResource = queryApi.root.addResource("customers").addResource("me").addResource("accounts");
    myAccountsResource.addMethod("GET", listMyAccountsIntegration, {
      methodResponses: [{ statusCode: "200" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: accountQueryAuthorizer,
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
    // サーバ側で判定するための実データとしてAccount aggregateに追加した。docs/adr/0016決定3
    // により、もはやリクエストボディでは受け取らない——認証済みユーザーのCognito subを
    // $context.authorizer.claims.subから直接使う(下記openCommandJson)。クライアントが
    // owner_idを自称できる余地自体を無くす。
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
    // channel: Deposit/Withdrawを起こした外部チャネル(docs/adr/0023)。deposits/withdrawals
    // は同じREST操作(入金/出金)を複数の外部チャネルが共有する(例: depositsはATM入金と
    // 他行からの振込の両方から呼ばれる)ため、URLパスやリソースの違いでは区別できず、
    // ボディで明示させる。入金・出金それぞれで実際にあり得るチャネルだけをenumで許可する
    // (FreezeCommandModelのreasonと同じ、値の妥当性はここで構造的に保証する方針)。
    const depositModel = commandApi.addModel("DepositCommandModel", {
      contentType: "application/json",
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ["amount", "channel"],
        properties: {
          amount: decimalStringSchema,
          channel: { type: apigateway.JsonSchemaType.STRING, enum: ["Atm", "IncomingTransfer"] },
        },
        additionalProperties: false,
      },
    });
    const withdrawalModel = commandApi.addModel("WithdrawalCommandModel", {
      contentType: "application/json",
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ["amount", "channel"],
        properties: {
          amount: decimalStringSchema,
          channel: { type: apigateway.JsonSchemaType.STRING, enum: ["Atm", "BillPayment"] },
        },
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
    // extraEnvelopeFieldsFragment: AccountCommandEnvelopeのcommand以外のトップレベル
    // フィールド(requested_by/channel)を追加するVTL断片。呼び出し元ごとに異なる値を渡す:
    // Open/Freeze/Unfreeze/CloseはAUTHORIZED_REQUESTED_BY_FIELD(下記、$context.authorizer.
    // claims.subをMessageBodyの`requested_by`として注入、docs/adr/0016決定3)、
    // Deposit/WithdrawはCHANNEL_FROM_BODY_FIELD(下記、リクエストボディの`channel`を
    // そのままMessageBodyの`channel`として注入、docs/adr/0023)——両者は排他的にしか
    // 使われないため、単一のフィールドで足りる。account-service/src/persistence.rsの
    // AccountCommandEnvelope側のフィールド名と一致させる。
    const sqsIntegration = (commandJsonFragment: string, extraEnvelopeFieldsFragment: string) =>
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
              `&MessageBody=$util.urlEncode("{\${q}account_id\${q}:\${q}$input.params('accountId')\${q},\${q}command\${q}:${commandJsonFragment}${extraEnvelopeFieldsFragment}}")`,
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

    // owner_idはリクエストボディからではなく、常にCognito認証済みユーザーのsubから取る
    // (docs/adr/0016決定3)——OpenCommandModelがowner_idを要求しなくなったのと対称。
    // owner_name(docs/adr/0018)も同じ理由でボディからは受け取らず、同じ認証済みクレーム
    // (`cognito:username`)から取る——振込確認画面(TransferForm.tsx)の「宛先名義」表示に
    // Cognitoのsub(UUID)がそのまま出てしまっていた不具合の修正。クレーム名にコロンを含む
    // ため`.sub`と同じドット記法は使えず、AWS公式ドキュメント(apigateway-enable-cognito-
    // user-pool.html)が示す`['claim-name']`のブラケット記法が必要——このVTL断片自体は
    // `$util.urlEncode("...")`の二重引用符リテラル内に埋め込まれるが、内側の単一引用符は
    // 衝突しない(同じ行の`$input.params('accountId')`で既に使われている形と同じ)。
    // usernameは(subと違い)ユーザーが選んだ値でCognitoの許容文字集合が`"`や`\`を排除しない
    // ため、initial_balanceと同じく`$util.escapeJavaScript`でJSON埋め込み時にエスケープする。
    const openCommandJson = `{\${q}Open\${q}:{\${q}owner_id\${q}:\${q}$context.authorizer.claims.sub\${q},\${q}owner_name\${q}:\${q}$util.escapeJavaScript($context.authorizer.claims['cognito:username'])\${q},\${q}initial_balance\${q}:\${q}$util.escapeJavaScript($input.path('$.initial_balance'))\${q}}}`;
    const depositCommandJson = `{\${q}Deposit\${q}:{\${q}amount\${q}:\${q}$util.escapeJavaScript($input.path('$.amount'))\${q}}}`;
    const withdrawCommandJson = `{\${q}Withdraw\${q}:{\${q}amount\${q}:\${q}$util.escapeJavaScript($input.path('$.amount'))\${q}}}`;
    const freezeCommandJson = `{\${q}Freeze\${q}:{\${q}reason\${q}:\${q}$util.escapeJavaScript($input.path('$.reason'))\${q}}}`;
    // Unfreeze/CloseはCommandのユニットバリアントであり、serdeのデフォルト外部タグ付け表現
    // では素のJSON文字列になる(account.rsにtag属性なし。{"Unfreeze":{}}ではない)。
    const unfreezeCommandJson = `\${q}Unfreeze\${q}`;
    const closeCommandJson = `\${q}Close\${q}`;

    // Open/Freeze/Unfreeze/Closeのsqsintegration呼び出しに渡す(docs/adr/0016決定3)。
    const AUTHORIZED_REQUESTED_BY_FIELD = `,\${q}requested_by\${q}:\${q}$context.authorizer.claims.sub\${q}`;
    // Deposit/Withdrawのsqsintegration呼び出しに渡す(docs/adr/0023)。リクエストボディの
    // `channel`(DepositCommandModel/WithdrawalCommandModelがenumで妥当性を保証済み)を、
    // owner_name(openCommandJson)と同じ理由でescapeJavaScriptしつつMessageBodyへ注入する。
    const CHANNEL_FROM_BODY_FIELD = `,\${q}channel\${q}:\${q}$util.escapeJavaScript($input.path('$.channel'))\${q}`;

    const requireIdempotencyKey = {
      "method.request.header.Idempotency-Key": true,
    };

    const commandAccountsResource = commandApi.root.addResource("accounts");
    const commandAccountResource = commandAccountsResource.addResource("{accountId}");

    // クライアントがUUIDを生成し、PUTで口座IDを指定して開設する(docs/adr/0006) —
    // AccountCommandEnvelopeがOpenを含む全コマンドでaccount_idを事前に要求する設計と一致し、
    // タイムアウト後の再送でも同じIDを使い回せる(べき等)。
    commandAccountResource.addMethod("PUT", sqsIntegration(openCommandJson, AUTHORIZED_REQUESTED_BY_FIELD), {
      requestValidator: commandRequestValidator,
      requestParameters: requireIdempotencyKey,
      requestModels: { "application/json": openModel },
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: accountCommandAuthorizer,
    });

    // Deposit/Withdraw(外部チャネル、認証なし、ADR-0009決定1)は引き続き認証を要求しない
    // (docs/adr/0016決定2)。
    commandAccountResource.addResource("deposits").addMethod("POST", sqsIntegration(depositCommandJson, CHANNEL_FROM_BODY_FIELD), {
      requestValidator: commandRequestValidator,
      requestParameters: requireIdempotencyKey,
      requestModels: { "application/json": depositModel },
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
    });

    commandAccountResource.addResource("withdrawals").addMethod("POST", sqsIntegration(withdrawCommandJson, CHANNEL_FROM_BODY_FIELD), {
      requestValidator: commandRequestValidator,
      requestParameters: requireIdempotencyKey,
      requestModels: { "application/json": withdrawalModel },
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
    });

    commandAccountResource.addResource("freeze").addMethod("POST", sqsIntegration(freezeCommandJson, AUTHORIZED_REQUESTED_BY_FIELD), {
      requestValidator: commandRequestValidator,
      requestParameters: requireIdempotencyKey,
      requestModels: { "application/json": freezeModel },
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: accountCommandAuthorizer,
    });

    commandAccountResource.addResource("unfreeze").addMethod("POST", sqsIntegration(unfreezeCommandJson, AUTHORIZED_REQUESTED_BY_FIELD), {
      requestValidator: commandParamsOnlyValidator,
      requestParameters: requireIdempotencyKey,
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: accountCommandAuthorizer,
    });

    commandAccountResource.addResource("close").addMethod("POST", sqsIntegration(closeCommandJson, AUTHORIZED_REQUESTED_BY_FIELD), {
      requestValidator: commandParamsOnlyValidator,
      requestParameters: requireIdempotencyKey,
      methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: accountCommandAuthorizer,
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
    addDlqAlarms("TransferCommandDlq", transferCommandDlq);
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
    //
    // docs/adr/0024: fee-serviceが発行する`fee.event.FeeReserved`もこのRuleに相乗りする
    // (新しいRule/Lambdaは追加しない、決定7)——sourceを追加するだけで、
    // saga_step.rsの`ReservingFee`向け分岐がイベントの中身(account_id/correlation_id/kind/data)
    // を見て処理する。
    new events.Rule(this, "TransferSagaObservationRule", {
      eventBus: domainEventBus,
      eventPattern: {
        source: [EVENT_SOURCE, FEE_EVENT_SOURCE],
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
    // Points service (docs/adr/0024) — ポイント台帳。account-domainにもtransfer-service/
    // fee-serviceにも依存しない末端サービス([[0016-cognito-authentication]]のauth-serviceと
    // 同じ立ち位置)。誰も知らない代わりに、誰からも(fee-service・transfer-serviceの両方から)
    // 利用される。
    // ==========================================================================

    // --- [Points service所有] 残高台帳(DynamoDB) -------------------------------
    const pointsTable = new dynamodb.Table(this, "PointsTable", {
      tableName: "moneta-points",
      partitionKey: { name: "ownerId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ReservePoints(fee-serviceが結果を待つ)だけがここへ書く(docs/adr/0024決定6)。
    // account_eventsと同じ「追記専用ログ→DynamoDB Streamsアウトボックス」の形。
    const pointsEventsTable = new dynamodb.Table(this, "PointsEventsTable", {
      tableName: "moneta-points-events",
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // SQS FIFOのMessageDeduplicationIdは送信時5分間の重複排除にしか効かず、Lambda側の
    // 再配信(可視性タイムアウト超過等)までは防げないため、account-serviceのprocessedMessages
    // と同じ専用の冪等性ログを持つ(docs/adr/0002決定4と同じ考え方)。
    const pointsIdempotencyTable = new dynamodb.Table(this, "PointsIdempotencyTable", {
      tableName: "moneta-points-idempotency",
      partitionKey: { name: "idempotencyKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 顧客向けポイント履歴(docs/adr/0026)。pointsEventsTable(fee-service向けアウトボックス、
    // ReservePoints専用)とは別の独立したテーブル——他サービスは一切読まないためEventBridge/
    // Lambda投影を経由させず、points-command-intakeが残高更新と同じTransactWriteItemsで
    // 直接書く。ソートキーはaccountHistoryTable(docs/adr/0009)と同じ「ゼロ埋めナノ秒
    // タイムスタンプ#eventId」——時刻順ソートと一意性を両立させる。
    const pointsHistoryTable = new dynamodb.Table(this, "PointsHistoryTable", {
      tableName: "moneta-points-history",
      partitionKey: { name: "ownerId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- [Points service所有] コマンド受付のSQS FIFOキュー ---------------------
    // fee-service(ReservePoints/RefundPoints)とtransfer-service(AwardPoints)の両方から
    // SendMessageされる(docs/adr/0024決定7)。
    const pointsCommandDlq = new sqs.Queue(this, "PointsCommandDlq", {
      queueName: "moneta-points-commands.fifo",
      fifo: true,
    });
    addDlqAlarms("PointsCommandDlq", pointsCommandDlq);
    const pointsCommandQueue = new sqs.Queue(this, "PointsCommandQueue", {
      queueName: "moneta-points-commands-main.fifo",
      fifo: true,
      contentBasedDeduplication: false,
      deadLetterQueue: {
        queue: pointsCommandDlq,
        maxReceiveCount: MAX_RECEIVE_COUNT,
      },
    });

    // --- [Points service所有] points-command-intake -----------------------------
    const pointsCommandIntakeFn = new lambda.Function(this, "PointsCommandIntakeFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("points-service", "points-command-intake"),
      environment: {
        POINTS_TABLE_NAME: pointsTable.tableName,
        POINTS_EVENTS_TABLE_NAME: pointsEventsTable.tableName,
        POINTS_IDEMPOTENCY_TABLE_NAME: pointsIdempotencyTable.tableName,
        POINTS_HISTORY_TABLE_NAME: pointsHistoryTable.tableName,
      },
    });
    pointsCommandIntakeFn.addEventSource(
      new SqsEventSource(pointsCommandQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );
    // account-serviceと同じ理由(このファイル冒頭のIAMコメント参照): TransactWriteItemsは
    // 各TransactItemの個別アクションも別途要求する。
    pointsTable.grantReadWriteData(pointsCommandIntakeFn);
    pointsTable.grant(pointsCommandIntakeFn, "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem");
    pointsEventsTable.grant(pointsCommandIntakeFn, "dynamodb:PutItem", "dynamodb:TransactWriteItems");
    pointsIdempotencyTable.grant(pointsCommandIntakeFn, "dynamodb:PutItem", "dynamodb:TransactWriteItems");
    pointsHistoryTable.grant(pointsCommandIntakeFn, "dynamodb:PutItem", "dynamodb:TransactWriteItems");

    // --- [Points service所有] points-outbox-projector ---------------------------
    const pointsOutboxProjectorDlq = new sqs.Queue(this, "PointsOutboxProjectorDlq");

    const pointsOutboxProjectorFn = new lambda.Function(this, "PointsOutboxProjectorFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("points-service", "points-outbox-projector"),
      environment: {
        EVENT_BUS_NAME: domainEventBus.eventBusName,
      },
    });
    domainEventBus.grantPutEventsTo(pointsOutboxProjectorFn);
    pointsOutboxProjectorFn.addEventSource(
      new DynamoEventSource(pointsEventsTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        retryAttempts: 3,
        reportBatchItemFailures: true,
        onFailure: new SqsDestination(pointsOutboxProjectorDlq),
      }),
    );

    // --- [Points service所有] PointsQueryApi: GET /customers/me/points(docs/adr/0025) ------
    // AccountNumberQueryApi([[0015-friendly-account-numbers-and-branch-and-other-bank-placeholder]])
    // と同じ独立したRestApiとして新設する——points-serviceはaccount-domainにもtransfer-service
    // にも依存しない独立サービスであり(docs/adr/0024決定1)、その照会APIも同じ独立性を保つ。
    // ownerIdはリクエストパラメータではなくCognito JWTのsubクレームから取る
    // (docs/adr/0016決定4の`GET /customers/me/accounts`と同じ形)。
    const pointsQueryApiDynamoRole = new iam.Role(this, "PointsQueryApiDynamoRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });
    pointsQueryApiDynamoRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [pointsTable.tableArn],
      }),
    );
    pointsQueryApiDynamoRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [pointsHistoryTable.tableArn],
      }),
    );

    const pointsQueryApi = new apigateway.RestApi(this, "PointsQueryApi", {
      restApiName: "moneta-points-query-api",
      deployOptions: { stageName: "prod" },
    });

    // 項目が存在しない(一度もポイントを獲得したことがない顧客)場合は404ではなく
    // {"balance": "0"}を返す(docs/adr/0025決定1)——ヘッダーに常に何かを表示したいという
    // 決定2の要件に対する自然な既定値であり、points-service自身も「存在しない項目=残高0」
    // という扱いを`ledger::reserve`/`credit`で既にしている(docs/adr/0024)。
    const getMyPointsIntegration = new apigateway.AwsIntegration({
      service: "dynamodb",
      action: "GetItem",
      options: {
        credentialsRole: pointsQueryApiDynamoRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          "application/json": JSON.stringify({
            TableName: pointsTable.tableName,
            Key: {
              ownerId: { S: "$context.authorizer.claims.sub" },
            },
          }),
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              "application/json": [
                '#if($input.path("$.Item") == "")',
                '{"balance": "0"}',
                "#else",
                '{"balance": "$input.path("$.Item.balance.S")"}',
                "#end",
              ].join("\n"),
            },
          },
        ],
      },
    });

    const myPointsResource = pointsQueryApi.root.addResource("customers").addResource("me").addResource("points");
    myPointsResource.addMethod("GET", getMyPointsIntegration, {
      methodResponses: [{ statusCode: "200" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: pointsQueryAuthorizer,
    });

    // GET /customers/me/points/history(docs/adr/0026)。accountHistoryTableの
    // listTransactionsIntegrationと同じ形——DynamoDB Query直接統合、新しい順
    // (ScanIndexForward: false)に最大50件、レスポンスVTLは各アイテムの`entry`属性
    // (points-service側で組み立て済みのJSON文字列、docs/adr/0009の教訓と同じくVTLでの
    // JSON組み立ては避ける)を`#foreach`で連結するだけ。
    const listPointsHistoryIntegration = new apigateway.AwsIntegration({
      service: "dynamodb",
      action: "Query",
      options: {
        credentialsRole: pointsQueryApiDynamoRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          "application/json": JSON.stringify({
            TableName: pointsHistoryTable.tableName,
            KeyConditionExpression: "ownerId = :ownerId",
            ExpressionAttributeValues: {
              ":ownerId": { S: "$context.authorizer.claims.sub" },
            },
            ScanIndexForward: false,
            Limit: 50,
          }),
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
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

    const myPointsHistoryResource = myPointsResource.addResource("history");
    myPointsHistoryResource.addMethod("GET", listPointsHistoryIntegration, {
      methodResponses: [{ statusCode: "200" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: pointsQueryAuthorizer,
    });

    // ==========================================================================
    // Fee service (docs/adr/0024) — 振込手数料のポリシー(金額決定・ポイント充当の可否判断)。
    // account-domainにもaccount-serviceにも一切依存しない・一切話しかけない——現金負担分は
    // transfer-service自身の既存のWithdraw/補償Depositに合算される(決定4)。points-serviceを
    // 利用する(コンパイル依存はゼロ)。
    // ==========================================================================

    // --- [Fee service所有] 予約台帳(DynamoDB) -----------------------------------
    const feeReservationsTable = new dynamodb.Table(this, "FeeReservationsTable", {
      tableName: "moneta-fee-reservations",
      partitionKey: { name: "transferId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // FeeReserved(transfer-serviceが結果を待つ)だけがここへ書く(docs/adr/0024決定6)。
    const feeEventsTable = new dynamodb.Table(this, "FeeEventsTable", {
      tableName: "moneta-fee-events",
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- [Fee service所有] コマンド受付のSQS FIFOキュー -------------------------
    const feeCommandDlq = new sqs.Queue(this, "FeeCommandDlq", {
      queueName: "moneta-fee-commands.fifo",
      fifo: true,
    });
    addDlqAlarms("FeeCommandDlq", feeCommandDlq);
    const feeCommandQueue = new sqs.Queue(this, "FeeCommandQueue", {
      queueName: "moneta-fee-commands-main.fifo",
      fifo: true,
      contentBasedDeduplication: false,
      deadLetterQueue: {
        queue: feeCommandDlq,
        maxReceiveCount: MAX_RECEIVE_COUNT,
      },
    });

    // --- [Fee service所有] fee-command-intake: ReserveFee/RefundFeeの受付 -------
    const feeCommandIntakeFn = new lambda.Function(this, "FeeCommandIntakeFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("fee-service", "fee-command-intake"),
      environment: {
        FEE_RESERVATIONS_TABLE_NAME: feeReservationsTable.tableName,
        FEE_EVENTS_TABLE_NAME: feeEventsTable.tableName,
        POINTS_COMMAND_QUEUE_URL: pointsCommandQueue.queueUrl,
      },
    });
    feeCommandIntakeFn.addEventSource(
      new SqsEventSource(feeCommandQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );
    feeReservationsTable.grantReadWriteData(feeCommandIntakeFn);
    pointsCommandQueue.grantSendMessages(feeCommandIntakeFn);

    // --- [Fee service所有] fee-points-observation: PointsReservedの観測 ---------
    // transfer-serviceのbin/saga_step.rsと同じ役割のfee-service版。
    const feePointsObservationFn = new lambda.Function(this, "FeePointsObservationFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("fee-service", "fee-points-observation"),
      environment: {
        FEE_RESERVATIONS_TABLE_NAME: feeReservationsTable.tableName,
        FEE_EVENTS_TABLE_NAME: feeEventsTable.tableName,
      },
    });
    feeReservationsTable.grantReadWriteData(feePointsObservationFn);
    feeReservationsTable.grant(feePointsObservationFn, "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem");
    feeEventsTable.grant(feePointsObservationFn, "dynamodb:PutItem", "dynamodb:TransactWriteItems");

    // points-serviceが発行する`points.event.PointsReserved`だけを購読する(fee-service以外は
    // このsourceを購読しない——transfer-serviceのTransferSagaObservationRuleには含めない)。
    new events.Rule(this, "FeePointsObservationRule", {
      eventBus: domainEventBus,
      eventPattern: {
        source: [POINTS_EVENT_SOURCE],
        detail: { correlation_id: [{ exists: true }] },
      },
      targets: [new targets.LambdaFunction(feePointsObservationFn)],
    });

    // --- [Fee service所有] fee-outbox-projector: FeeReservedの発行 --------------
    const feeOutboxProjectorDlq = new sqs.Queue(this, "FeeOutboxProjectorDlq");

    const feeOutboxProjectorFn = new lambda.Function(this, "FeeOutboxProjectorFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("fee-service", "fee-outbox-projector"),
      environment: {
        EVENT_BUS_NAME: domainEventBus.eventBusName,
      },
    });
    domainEventBus.grantPutEventsTo(feeOutboxProjectorFn);
    feeOutboxProjectorFn.addEventSource(
      new DynamoEventSource(feeEventsTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        retryAttempts: 3,
        reportBatchItemFailures: true,
        onFailure: new SqsDestination(feeOutboxProjectorDlq),
      }),
    );

    // --- [Transfer service所有] fee-service/points-serviceの利用配線 -----------
    // docs/adr/0024決定4・決定5・決定7: transfer-serviceはfee-service/points-serviceへ
    // コンパイル依存を一切持たない(利用のみ)。既存のLambda定義(上のTransfer serviceセクション)
    // には手を入れず、環境変数・IAM権限だけを後から追加する——このリポジトリの「新機能は
    // 既存の定義ブロックを書き換えず追記する」という増分の作法に倣う。
    transferCommandIntakeFn.addEnvironment("FEE_COMMAND_QUEUE_URL", feeCommandQueue.queueUrl);
    feeCommandQueue.grantSendMessages(transferCommandIntakeFn);

    transferSagaStepFn.addEnvironment("FEE_COMMAND_QUEUE_URL", feeCommandQueue.queueUrl);
    transferSagaStepFn.addEnvironment("POINTS_COMMAND_QUEUE_URL", pointsCommandQueue.queueUrl);
    feeCommandQueue.grantSendMessages(transferSagaStepFn);
    pointsCommandQueue.grantSendMessages(transferSagaStepFn);

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

    // --- 顧客ごとの送金履歴(docs/adr/0017) --------------------------------------
    // TransferSagaTableへのGSI追加ではなく、transfer-status-projectorと同型の専用の
    // 小さな投影(決定1)。送金元・送金先両方のownerId向けに書く(決定2)ため、
    // TransferAccountOwnersTable([[0011]])からの名義解決が要る。
    //
    // ベーステーブルの範囲キーはtransferId(実デプロイでの確認により判明した設計修正——
    // 当初`updatedAt#transferId`にしていたところ、サガが状態遷移するたびに別アイテムとして
    // 積み上がってしまう実バグを起こした)。「新しい順」の並び替えは別途GSI(`byUpdatedAt`)
    // で実現する——account-numbers-tableのbyAccountId GSIと同じ「逆引き/別順序用の
    // 専用インデックス」という使い方。
    // 論理ID"V2"は意図的(実デプロイでの確認により判明): 固定TableNameを持つリソースの
    // キースキーマ変更は、CloudFormationが「置き換えを要する変更」と分類した時点で
    // 「まずリネームしてから再デプロイせよ」と拒否する——実際にAWS側のテーブルを手動削除
    // しても、CloudFormationのスタック状態(直前の成功デプロイのテンプレート)がまだ同じ
    // 論理IDを追跡している限りこの拒否は変わらない。論理ID自体を変えることで
    // CloudFormationに「新規作成+別リソースの削除」として扱わせ、この制約を回避する。
    const customerTransfersTable = new dynamodb.Table(this, "CustomerTransfersTableV2", {
      tableName: "moneta-customer-transfers",
      partitionKey: { name: "ownerId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "transferId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    customerTransfersTable.addGlobalSecondaryIndex({
      indexName: "byUpdatedAt",
      partitionKey: { name: "ownerId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "updatedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const transferHistoryProjectorDlq = new sqs.Queue(this, "TransferHistoryProjectorDlq");

    const transferHistoryProjectorFn = new lambda.Function(this, "TransferHistoryProjectorFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      code: rustLambdaCode("transfer-service", "transfer-history-projector"),
      environment: {
        CUSTOMER_TRANSFERS_TABLE_NAME: customerTransfersTable.tableName,
        OWNER_TABLE_NAME: transferAccountOwnersTable.tableName,
      },
    });
    customerTransfersTable.grantWriteData(transferHistoryProjectorFn);
    transferAccountOwnersTable.grantReadData(transferHistoryProjectorFn);

    transferHistoryProjectorFn.addEventSource(
      new DynamoEventSource(transferSagaTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        retryAttempts: 3,
        reportBatchItemFailures: true,
        onFailure: new SqsDestination(transferHistoryProjectorDlq),
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
              // docs/adr/0027決定2: 404判定の次に、認証済みユーザー(sub)が送金元・送金先
              // どちらの名義でもなければ403(振込は送金元・送金先で名義が異なるため「いずれか
              // 一致」——[[0020]]が確立した「送金元/送金先どちらから見ても自分の送金として
              // 見える」という前提と対称)。
              "application/json": [
                '#if($input.path("$.Item") == "")',
                "#set($context.responseOverride.status = 404)",
                '{"message": "transfer not found"}',
                '#elseif($input.path("$.Item.fromOwnerId.S") != $context.authorizer.claims.sub && $input.path("$.Item.toOwnerId.S") != $context.authorizer.claims.sub)',
                "#set($context.responseOverride.status = 403)",
                '{"message": "forbidden"}',
                "#else",
                "{",
                '"transferId":"$input.path("$.Item.transferId.S")",',
                '"fromAccountId":"$input.path("$.Item.fromAccountId.S")",',
                '"toAccountId":"$input.path("$.Item.toAccountId.S")",',
                '"amount":"$input.path("$.Item.amount.S")",',
                '"kind":"$input.path("$.Item.kind.S")",',
                '"state":"$input.path("$.Item.state.S")",',
                '"updatedAt":"$input.path("$.Item.updatedAt.S")",',
                // docs/adr/0025: 振込の現金負担分の手数料("0"なら振替・組戻し、または
                // まだ手数料原資確保前)。送金詳細画面に表示するためだけの追加で、
                // transfer-serviceの他のロジックはこの値を一切参照しない。
                //
                // cashFee導入(0024/0025)より前に作られたサガの項目は、この属性自体を
                // 持たない——DynamoDBはスキーマレスで、既存アイテムへ新しい必須属性を
                // 後から強制する仕組みが無い(0011のowner_id導入時と同じ既知の現象)。
                // 属性が無い場合、$input.pathは空文字列を返す(例外にはならない)——それを
                // そのまま`"cashFee":""`にすると、web-ui側のformatCurrencyが「¥」のみの
                // 壊れた表示になる(実機で発見)。"0"にフォールバックし、振替・組戻しと
                // 同じ「手数料なし」として扱う。
                '#if($input.path("$.Item.cashFee") == "")',
                '"cashFee":"0",',
                "#else",
                '"cashFee":"$input.path("$.Item.cashFee.S")",',
                "#end",
                // docs/adr/0025決定4: 振込の手数料のうちポイントで充当した分。cashFeeと
                // 同じ「未設定なら0にフォールバック」を適用する(このフィールド自体が
                // cashFeeより後から追加されたため、既存項目はより広範囲に欠けている)。
                '#if($input.path("$.Item.pointsUsed") == "")',
                '"pointsUsed":"0"',
                "#else",
                '"pointsUsed":"$input.path("$.Item.pointsUsed.S")"',
                "#end",
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
      methodResponses: [{ statusCode: "200" }, { statusCode: "403" }, { statusCode: "404" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: transferQueryAuthorizer,
    });

    // GET /customers/me/transfers: ownerIdはリクエストパラメータではなくCognito JWTのsub
    // クレームから取る(docs/adr/0016決定4と同じパターン、docs/adr/0017決定3)。
    // byUpdatedAt GSIに対してQueryし、ScanIndexForward: falseで更新日時の新しい順を返す
    // (ベーステーブル自体のSKはtransferId固定——上記コメント参照)。
    transferQueryApiDynamoRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [`${customerTransfersTable.tableArn}/index/byUpdatedAt`],
      }),
    );

    const listMyTransfersIntegration = new apigateway.AwsIntegration({
      service: "dynamodb",
      action: "Query",
      options: {
        credentialsRole: transferQueryApiDynamoRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          "application/json": JSON.stringify({
            TableName: customerTransfersTable.tableName,
            IndexName: "byUpdatedAt",
            KeyConditionExpression: "ownerId = :ownerId",
            ExpressionAttributeValues: {
              ":ownerId": { S: "$context.authorizer.claims.sub" },
            },
            ScanIndexForward: false,
          }),
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              "application/json": [
                "#set($items = $input.path('$.Items'))",
                "[",
                "#foreach($item in $items)",
                "{",
                '"transferId":"$item.transferId.S",',
                '"fromAccountId":"$item.fromAccountId.S",',
                '"toAccountId":"$item.toAccountId.S",',
                '"amount":"$item.amount.S",',
                '"kind":"$item.kind.S",',
                '"state":"$item.state.S",',
                '"updatedAt":"$item.updatedAt.S"',
                "}#if($foreach.hasNext),#end",
                "#end",
                "]",
              ].join("\n"),
            },
          },
        ],
      },
    });

    const myTransfersResource = transferQueryApi.root
      .addResource("customers")
      .addResource("me")
      .addResource("transfers");
    myTransfersResource.addMethod("GET", listMyTransfersIntegration, {
      methodResponses: [{ statusCode: "200" }],
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: transferQueryAuthorizer,
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
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: transferCommandAuthorizer,
    });

    transferCommandTransferResource
      .addResource("confirm")
      .addMethod("POST", transferSqsIntegration(confirmCommandJson, "confirm"), {
        requestValidator: transferCommandParamsOnlyValidator,
        methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: transferCommandAuthorizer,
      });

    transferCommandTransferResource
      .addResource("cancel")
      .addMethod("POST", transferSqsIntegration(cancelCommandJson, "cancel"), {
        requestValidator: transferCommandParamsOnlyValidator,
        methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: transferCommandAuthorizer,
      });

    // 組戻し。パスの{transferId}は組戻し自身の新しいサガID、取消対象はbodyのoriginal_transfer_id
    // (決定4: 「新しいリソースをこのIDで作る」というPUTの意味論をStartと揃える)。
    transferCommandTransferResource
      .addResource("recall")
      .addMethod("PUT", transferSqsIntegration(recallCommandJson, "recall"), {
        requestValidator: transferCommandRequestValidator,
        requestModels: { "application/json": recallTransferModel },
        methodResponses: [{ statusCode: "202" }, { statusCode: "502" }],
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: transferCommandAuthorizer,
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

    // 口座番号照会API(docs/adr/0015)。account-service/transfer-serviceのものとは別プレフィックス
    // にする理由は上記2つと同じ。
    const accountNumberQueryApiPrefixFunction = new cloudfront.Function(this, "AccountNumberQueryApiPrefixFunction", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          "function handler(event) {",
          "  var request = event.request;",
          '  request.uri = request.uri.replace(/^\\/account-number-query-api/, "") || "/";',
          "  return request;",
          "}",
        ].join("\n"),
      ),
    });

    // docs/adr/0025。
    const pointsQueryApiPrefixFunction = new cloudfront.Function(this, "PointsQueryApiPrefixFunction", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          "function handler(event) {",
          "  var request = event.request;",
          '  request.uri = request.uri.replace(/^\\/points-query-api/, "") || "/";',
          "  return request;",
          "}",
        ].join("\n"),
      ),
    });

    // CloudFrontはデフォルトで任意ヘッダーをオリジンへ転送しないため、Idempotency-Key
    // (ADR-0006決定3)を明示的に転送する(command-apiのみ必要)。
    const commandApiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, "CommandApiOriginRequestPolicy", {
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList("Idempotency-Key", "Content-Type"),
    });

    // Authorization(docs/adr/0016、Cognito IDトークン)は5つのbehavior全てで必要だが、
    // OriginRequestPolicyのallowListにAuthorizationを含めることはCDK/CloudFront自体が拒否する
    // ("you cannot pass `Authorization` or `Accept-Encoding` as header values" — cdk synth時点で
    // 判明)。AuthorizationはCachePolicy側のheaderBehaviorでのみ転送できる。加えて、
    // 全TTLを0(=CACHING_DISABLED相当)にした状態でheaderBehaviorを指定すると、今度は実際の
    // デプロイ時点で"HeaderBehavior is invalid for policy with caching disabled"というCloudFront
    // 側のバリデーションで拒否されることが判明した(cdk synthは通るが実機で失敗する——
    // CLAUDE.mdの「AWS/ライブラリの挙動は推測せず検証する」を二重に地で行く形になった)。
    // やむを得ずTTLを1秒だけ持たせる——結果整合性のラグ(最大約1分)を既に許容しているこの
    // システム全体からすれば、1秒のキャッシュ窓は無視できるほど小さく、ADR-0007の
    // 「結果整合性のあるレスポンスをCDNにキャッシュさせない」という意図を実質的に損なわない。
    // headerBehaviorにAuthorizationを含めることで、キャッシュキー自体がトークンごとに
    // 分かれる(他人のレスポンスが誤って返る心配もない)。
    const authCachePolicy = new cloudfront.CachePolicy(this, "AuthCachePolicy", {
      defaultTtl: cdk.Duration.seconds(1),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList("Authorization"),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const webUiDistribution = new cloudfront.Distribution(this, "WebUiDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webUiBucket),
      },
      additionalBehaviors: {
        "/query-api/*": {
          origin: new origins.RestApiOrigin(queryApi),
          cachePolicy: authCachePolicy,
          functionAssociations: [
            { function: queryApiPrefixFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        "/command-api/*": {
          origin: new origins.RestApiOrigin(commandApi),
          // デフォルト(ALLOW_GET_HEAD)だとPUT/POSTが403になる(実機検証で発見)。書き込み
          // コマンドはPUT(Open)とPOST(Deposit等)のため明示的に全メソッドを許可する。
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: authCachePolicy,
          originRequestPolicy: commandApiOriginRequestPolicy,
          functionAssociations: [
            { function: commandApiPrefixFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        "/transfer-query-api/*": {
          origin: new origins.RestApiOrigin(transferQueryApi),
          cachePolicy: authCachePolicy,
          functionAssociations: [
            { function: transferQueryApiPrefixFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        "/transfer-command-api/*": {
          origin: new origins.RestApiOrigin(transferCommandApi),
          // account-serviceのcommand-apiと同じ理由(デフォルトのALLOW_GET_HEADだとPUT/POSTが
          // 403になる)。
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: authCachePolicy,
          functionAssociations: [
            { function: transferCommandApiPrefixFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        "/account-number-query-api/*": {
          origin: new origins.RestApiOrigin(accountNumberQueryApi),
          cachePolicy: authCachePolicy,
          functionAssociations: [
            { function: accountNumberQueryApiPrefixFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        "/points-query-api/*": {
          origin: new origins.RestApiOrigin(pointsQueryApi),
          cachePolicy: authCachePolicy,
          functionAssociations: [
            { function: pointsQueryApiPrefixFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
      defaultRootObject: "index.html",
    });

    // web-ui/distが必要(docs/adr/0007決定「既知のギャップ」参照)。Rust Lambda群のような
    // Dockerバンドリングは不要と判断した——Node/npmのビルドにはLambda実行時とのglibc
    // バージョン互換性問題が無いため。ビルド自体はinfra/package.jsonのpre-hook
    // (pretest/presynth/prediff/predeploy/predestroy → build-web-ui)が毎回自動で行うので、
    // ここでの前提は「(このCDKアプリを起動したnpmコマンド経由なら)常に最新」でよい。
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
    new cdk.CfnOutput(this, "AccountNumbersTableName", { value: accountNumbersTable.tableName });
    new cdk.CfnOutput(this, "AccountNumberProjectorFunctionName", { value: accountNumberProjectorFn.functionName });
    new cdk.CfnOutput(this, "AccountNumberQueryApiUrl", { value: accountNumberQueryApi.url });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "CustomerAccountsTableName", { value: customerAccountsTable.tableName });
    new cdk.CfnOutput(this, "CustomerAccountsProjectorFunctionName", { value: customerAccountsProjectorFn.functionName });
    new cdk.CfnOutput(this, "CustomerTransfersTableName", { value: customerTransfersTable.tableName });
    new cdk.CfnOutput(this, "TransferHistoryProjectorFunctionName", { value: transferHistoryProjectorFn.functionName });
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
    new cdk.CfnOutput(this, "PointsTableName", { value: pointsTable.tableName });
    new cdk.CfnOutput(this, "PointsHistoryTableName", { value: pointsHistoryTable.tableName });
    new cdk.CfnOutput(this, "PointsCommandQueueUrl", { value: pointsCommandQueue.queueUrl });
    new cdk.CfnOutput(this, "PointsCommandIntakeFunctionName", { value: pointsCommandIntakeFn.functionName });
    new cdk.CfnOutput(this, "PointsOutboxProjectorFunctionName", { value: pointsOutboxProjectorFn.functionName });
    new cdk.CfnOutput(this, "PointsQueryApiUrl", { value: pointsQueryApi.url });
    new cdk.CfnOutput(this, "FeeReservationsTableName", { value: feeReservationsTable.tableName });
    new cdk.CfnOutput(this, "FeeCommandQueueUrl", { value: feeCommandQueue.queueUrl });
    new cdk.CfnOutput(this, "FeeCommandIntakeFunctionName", { value: feeCommandIntakeFn.functionName });
    new cdk.CfnOutput(this, "FeePointsObservationFunctionName", { value: feePointsObservationFn.functionName });
    new cdk.CfnOutput(this, "FeeOutboxProjectorFunctionName", { value: feeOutboxProjectorFn.functionName });
  }
}

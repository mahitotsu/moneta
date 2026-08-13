use account_domain::{Event, EventEnvelope};
use aws_lambda_events::eventbridge::EventBridgeEvent;
use aws_sdk_dynamodb::types::AttributeValue;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};

const EVENT_KIND: &str = "event";

/// query-service専用の、「本物の顧客-口座関係」のためだけの小さなイベント駆動投影
/// (docs/adr/0016決定4)。`crates/transfer-service/src/bin/owner_projector.rs`(docs/adr/0011)
/// と同型: `account.event.Opened`だけを購読し、`Opened`一度きりで決まる不変データ
/// (どのownerIdがどのaccountIdを開設したか)を専用の小テーブルへ書く。
///
/// [[0009-web-ui-customer-experience-and-channel-emulation]]決定2が「顧客-口座関係は
/// バックエンドに実装せず、Web UIのlocalStorageのみで表現する」としていたのを、認証の導入
/// (docs/adr/0016)をもって見直す——`ownerId`がもはやCognitoで認証済みの`sub`である以上、
/// 「このユーザーの口座一覧」をサーバー側で正しく答えられる。`GET /customers/me/accounts`
/// (Lambdaレス、DynamoDB Query直接統合)がこのテーブルを読む。
#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .without_time()
        .init();

    let table_name =
        std::env::var("CUSTOMER_ACCOUNTS_TABLE_NAME").expect("CUSTOMER_ACCOUNTS_TABLE_NAME environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = aws_sdk_dynamodb::Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<EventBridgeEvent<EventEnvelope>>| {
        let dynamodb = dynamodb.clone();
        let table_name = table_name.clone();
        async move { project_one(&dynamodb, &table_name, event.payload.detail).await }
    }))
    .await
}

async fn project_one(dynamodb: &aws_sdk_dynamodb::Client, table_name: &str, envelope: EventEnvelope) -> Result<(), Error> {
    if envelope.kind != EVENT_KIND {
        // EventBridge Rule側の購読条件(account.event.Openedのみ)を満たしていれば通常ここには
        // 来ないが、他のprojectorと同じく境界での防御チェックとして残す。
        tracing::warn!(kind = %envelope.kind, "ignoring non-event envelope");
        return Ok(());
    }

    let event: Event = serde_json::from_value(envelope.data)?;

    let Event::Opened { owner_id, .. } = event else {
        // 購読条件がaccount.event.Openedだけのはずだが、万一広がっても無害に無視する。
        tracing::warn!("ignoring non-Opened event delivered to the customer accounts projector");
        return Ok(());
    };

    // ownerId(=Cognitoのsub)は開設時から不変なので、owner_projector.rsと同じく
    // ConditionExpressionなしの無条件PutItemで足りる。
    dynamodb
        .put_item()
        .table_name(table_name)
        .item("ownerId", AttributeValue::S(owner_id))
        .item("accountId", AttributeValue::S(envelope.account_id.to_string()))
        .item(
            "openedAt",
            AttributeValue::S(envelope.occurred_at.format(&account_domain::Rfc3339).expect("OffsetDateTime always formats as RFC3339")),
        )
        .send()
        .await?;

    Ok(())
}

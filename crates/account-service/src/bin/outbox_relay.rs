use account_service::{outbox, persistence};
use aws_sdk_eventbridge::types::PutEventsRequestEntry;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use sqlx::PgPool;

/// PutEventsは1リクエストあたり最大10エントリ(EventBridgeのAPI上限)。
const BATCH_SIZE: i64 = 10;
const EVENT_SOURCE: &str = "account-service";

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .without_time()
        .init();

    let database_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL environment variable must be set");
    let pool = aurora_dsql_sqlx_connector::pool::connect(&database_url).await?;

    let event_bus_name =
        std::env::var("EVENT_BUS_NAME").expect("EVENT_BUS_NAME environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let eventbridge = aws_sdk_eventbridge::Client::new(&aws_config);

    run(service_fn(move |_event: LambdaEvent<serde_json::Value>| {
        let pool = pool.clone();
        let eventbridge = eventbridge.clone();
        let event_bus_name = event_bus_name.clone();
        async move { relay_once(&pool, &eventbridge, &event_bus_name).await }
    }))
    .await
}

/// `account_events`の未発行分(`published_at IS NULL`)を1バッチ取得し、EventBridgeへ発行する
/// (docs/adr/0004: ポーリングベースのトランザクショナルアウトボックス)。
///
/// PutEventsはエントリ単位で成否が返るため、成功したものだけ`published_at`を更新する。
/// 発行→記録の順序を守ることで、この関数の途中でLambdaが落ちても「発行したのに未発行のまま」
/// にはならず、最悪でも重複発行に倒れる(at-least-once。ADR-0002のSQS処理と同じ設計思想)。
async fn relay_once(
    pool: &PgPool,
    eventbridge: &aws_sdk_eventbridge::Client,
    event_bus_name: &str,
) -> Result<(), Error> {
    let unpublished = persistence::fetch_unpublished_events(pool, BATCH_SIZE).await?;
    if unpublished.is_empty() {
        return Ok(());
    }

    let mut entries = Vec::with_capacity(unpublished.len());
    for event in &unpublished {
        let outbox::OutboxEntry { detail_type, detail } = outbox::to_outbox_entry(event);
        entries.push(
            PutEventsRequestEntry::builder()
                .event_bus_name(event_bus_name)
                .source(EVENT_SOURCE)
                .detail_type(detail_type)
                .detail(serde_json::to_string(&detail)?)
                .build(),
        );
    }

    let response = eventbridge.put_events().set_entries(Some(entries)).send().await?;

    for (event, result) in unpublished.iter().zip(response.entries()) {
        match result.error_code() {
            None => persistence::mark_published(pool, event.id).await?,
            Some(code) => tracing::error!(
                event_id = %event.id,
                error_code = code,
                error_message = ?result.error_message(),
                "failed to publish event to EventBridge; will retry on next poll"
            ),
        }
    }

    Ok(())
}

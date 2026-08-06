use account_domain::{Event, EventEnvelope};
use aws_lambda_events::eventbridge::EventBridgeEvent;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use transfer_service::persistence;

const EVENT_KIND: &str = "event";

/// Transfer service専用の、口座名義(owner_id)のためだけの小さなイベント駆動投影
/// (docs/adr/0011)。query-serviceのAccountViewTable(`query_projector.rs`)とは別に持つ:
/// あちらは`view_from_event`がイベント単体からフルの新state JSONを都度PutItemする
/// 「洗い替え」設計のため、owner_idのような`Opened`一度きりで決まる不変データを他のイベント
/// (Deposited/Withdrawn等)の書き込み時に消さずに引き継ぐには読み取り-書き込みマージが
/// 必要になり複雑化する。名義は不変なので、専用テーブルへ`Opened`のときだけ書けば足りる。
#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .without_time()
        .init();

    let table_name = std::env::var("OWNER_TABLE_NAME").expect("OWNER_TABLE_NAME environment variable must be set");
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
        // 来ないが、query_projector.rsと同じく境界での防御チェックとして残す。
        tracing::warn!(kind = %envelope.kind, "ignoring non-event envelope");
        return Ok(());
    }

    let event: Event = serde_json::from_value(envelope.data)?;

    let Event::Opened { owner_id, .. } = event else {
        // 購読条件がaccount.event.Openedだけのはずだが、万一広がっても無害に無視する。
        tracing::warn!("ignoring non-Opened event delivered to the owner projector");
        return Ok(());
    };

    persistence::save_owner(dynamodb, table_name, envelope.account_id, &owner_id).await?;
    Ok(())
}

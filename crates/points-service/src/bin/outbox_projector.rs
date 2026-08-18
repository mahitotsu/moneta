//! `PointsEventsTable`のDynamoDB Streamsから`points.event.PointsReserved`をEventBridgeへ発行する
//! (docs/adr/0024決定6)。`account-service`の`account_outbox_projector.rs`(docs/adr/0004・0013)と
//! 同じ「DynamoDB Streams駆動のトランザクショナルアウトボックス」を再利用するが、points-service
//! は`ReservePoints`のためだけにアウトボックスを持つ(`AwardPoints`/`RefundPoints`はそもそも
//! このテーブルに書かない、決定6)ため、`account-service`のような`event`/`rejection`の分岐や
//! 複数のイベント種別への対応は不要——常に`points.event.PointsReserved`として発行する。

use aws_lambda_events::dynamodb::{Event as DynamoDbEvent, EventRecord};
use aws_sdk_eventbridge::types::PutEventsRequestEntry;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Deserialize, Serialize};

const PUT_EVENTS_BATCH_SIZE: usize = 10;
const EVENT_SOURCE: &str = "points-service";
const DETAIL_TYPE: &str = "points.event.PointsReserved";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamBatchResponse {
    batch_item_failures: Vec<BatchItemFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct BatchItemFailure {
    item_identifier: String,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let event_bus_name = std::env::var("EVENT_BUS_NAME").expect("EVENT_BUS_NAME environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let eventbridge = aws_sdk_eventbridge::Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<DynamoDbEvent>| {
        let eventbridge = eventbridge.clone();
        let event_bus_name = event_bus_name.clone();
        async move { handle_batch(&eventbridge, &event_bus_name, event.payload).await }
    }))
    .await
}

/// `account_outbox_projector.rs`の`handle_batch`と同じ構造(docs/adr/0004決定2): 失敗した
/// エントリだけを`batchItemFailures`として報告する。
async fn handle_batch(eventbridge: &aws_sdk_eventbridge::Client, event_bus_name: &str, event: DynamoDbEvent) -> Result<StreamBatchResponse, Error> {
    let mut failures = Vec::new();

    for chunk in event.records.chunks(PUT_EVENTS_BATCH_SIZE) {
        let mut entries = Vec::with_capacity(chunk.len());
        let mut sequence_numbers = Vec::with_capacity(chunk.len());

        for record in chunk {
            let Some(image) = event_image_from_record(record) else {
                tracing::warn!(event_id = %record.event_id, "skipping stream record without a usable NEW_IMAGE");
                continue;
            };
            // `account_domain::EventEnvelope`と同じ形の最小限の外枠を、points-serviceが
            // 独立に組み立てる(account-domainに依存しない、docs/adr/0024決定1)。fee-serviceの
            // 観測Lambdaは`correlation_id`(=transfer_id)で自分の`FeeReservationsTable`の
            // 行を引き当てる——`account_id`に相当するものが無い(points-serviceはownerId単位
            // なので`owner_id`をそのまま使う)。
            let detail = serde_json::json!({
                "owner_id": image.owner_id,
                "correlation_id": image.correlation_id,
                "data": serde_json::from_str::<serde_json::Value>(&image.data).unwrap_or(serde_json::Value::Null),
            });
            entries.push(
                PutEventsRequestEntry::builder()
                    .event_bus_name(event_bus_name)
                    .source(EVENT_SOURCE)
                    .detail_type(DETAIL_TYPE)
                    .detail(detail.to_string())
                    .build(),
            );
            sequence_numbers.push(record.change.sequence_number.clone().unwrap_or_default());
        }

        if entries.is_empty() {
            continue;
        }

        let response = eventbridge.put_events().set_entries(Some(entries)).send().await?;

        for (sequence_number, result) in sequence_numbers.iter().zip(response.entries()) {
            if let Some(code) = result.error_code() {
                tracing::error!(
                    sequence_number,
                    error_code = code,
                    error_message = ?result.error_message(),
                    "failed to publish event to EventBridge; reporting for retry"
                );
                failures.push(BatchItemFailure { item_identifier: sequence_number.clone() });
            }
        }
    }

    Ok(StreamBatchResponse { batch_item_failures: failures })
}

/// `PointsEventsTable`のNEW_IMAGE形状(`persistence.rs`の`points_reserved_event_put`が
/// 書き込む属性名と対応させる)。
#[derive(Debug, Deserialize)]
struct EventImage {
    #[serde(rename = "ownerId")]
    owner_id: String,
    #[serde(rename = "correlationId")]
    correlation_id: String,
    data: String,
}

fn event_image_from_record(record: &EventRecord) -> Option<EventImage> {
    serde_dynamo::from_item(record.change.new_image.clone())
        .inspect_err(|err| tracing::warn!(%err, "failed to deserialize NEW_IMAGE"))
        .ok()
}

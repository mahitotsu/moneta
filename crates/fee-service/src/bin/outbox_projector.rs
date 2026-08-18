//! `FeeEventsTable`のDynamoDB Streamsから`fee.event.FeeReserved`をEventBridgeへ発行する
//! (docs/adr/0024決定6)。`points-service`の`bin/outbox_projector.rs`と同じ構造だが、この発行先
//! (`transfer-service`の`bin/saga_step.rs`)は`account_domain::EventEnvelope`型で`detail`を
//! パースするため、`occurred_at`は**その型のSerialize実装と一致する形**でなければならない。
//!
//! `time`クレートの`serde-human-readable`は`OffsetDateTime`をRFC3339ではなく独自の
//! (スペース区切りの)可読形式でシリアライズする(`time-0.3.54`のソースで確認済み、
//! CLAUDE.mdの「AWS/ライブラリの挙動は仮定せず確認する」方針の通り)。fee-serviceは
//! account-domainに依存しない(docs/adr/0024決定1)ため`EventEnvelope`型そのものは使えないが、
//! フィールド形状が同じローカル構造体に`time::OffsetDateTime`の値を直接持たせてシリアライズ
//! すれば、同じ`time`クレート(ワークスペース共通のCargo.lockにより同一バージョン)のSerialize
//! 実装が使われるため、手でRFC3339文字列を組み立てるより確実に形式が一致する。

use aws_lambda_events::dynamodb::{Event as DynamoDbEvent, EventRecord};
use aws_sdk_eventbridge::types::PutEventsRequestEntry;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Deserialize, Serialize};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

const PUT_EVENTS_BATCH_SIZE: usize = 10;
const EVENT_SOURCE: &str = "fee-service";
const DETAIL_TYPE: &str = "fee.event.FeeReserved";

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

/// `account_domain::EventEnvelope`とフィールド形状を一致させたローカル定義
/// (docs/adr/0024決定1: account-domainには依存しない、コードは共有せず形だけ合わせる)。
#[derive(Serialize)]
struct EventEnvelopeLike {
    event_id: Uuid,
    account_id: Uuid,
    occurred_at: OffsetDateTime,
    kind: String,
    data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
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

async fn handle_batch(eventbridge: &aws_sdk_eventbridge::Client, event_bus_name: &str, event: DynamoDbEvent) -> Result<StreamBatchResponse, Error> {
    let mut failures = Vec::new();

    for chunk in event.records.chunks(PUT_EVENTS_BATCH_SIZE) {
        let mut entries = Vec::with_capacity(chunk.len());
        let mut sequence_numbers = Vec::with_capacity(chunk.len());

        for record in chunk {
            let Some(envelope) = envelope_from_record(record) else {
                tracing::warn!(event_id = %record.event_id, "skipping stream record without a usable NEW_IMAGE");
                continue;
            };
            let detail = match serde_json::to_string(&envelope) {
                Ok(detail) => detail,
                Err(err) => {
                    tracing::warn!(%err, "failed to serialize EventEnvelopeLike; skipping record");
                    continue;
                }
            };
            entries.push(
                PutEventsRequestEntry::builder()
                    .event_bus_name(event_bus_name)
                    .source(EVENT_SOURCE)
                    .detail_type(DETAIL_TYPE)
                    .detail(detail)
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

/// `FeeEventsTable`のNEW_IMAGE形状(`persistence.rs`の`advance_to_reserved`が書き込む属性名と
/// 対応させる)。
#[derive(Debug, Deserialize)]
struct EventImage {
    #[serde(rename = "eventId")]
    event_id: Uuid,
    #[serde(rename = "accountId")]
    account_id: Uuid,
    kind: String,
    data: String,
    #[serde(rename = "correlationId")]
    correlation_id: String,
    #[serde(rename = "occurredAt")]
    occurred_at: String,
}

fn envelope_from_record(record: &EventRecord) -> Option<EventEnvelopeLike> {
    let image: EventImage = serde_dynamo::from_item(record.change.new_image.clone())
        .inspect_err(|err| tracing::warn!(%err, "failed to deserialize NEW_IMAGE"))
        .ok()?;
    Some(EventEnvelopeLike {
        event_id: image.event_id,
        account_id: image.account_id,
        occurred_at: OffsetDateTime::parse(&image.occurred_at, &Rfc3339).ok()?,
        kind: image.kind,
        data: serde_json::from_str(&image.data).ok()?,
        correlation_id: Some(image.correlation_id),
        channel: None,
    })
}

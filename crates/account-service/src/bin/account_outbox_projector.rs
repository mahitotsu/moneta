use account_domain::{OffsetDateTime, Rfc3339, Uuid};
use account_service::{outbox, persistence::UnpublishedEvent};
use aws_lambda_events::dynamodb::{Event as DynamoDbEvent, EventRecord};
use aws_sdk_eventbridge::types::PutEventsRequestEntry;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Deserialize, Serialize};

/// PutEventsは1リクエストあたり最大10エントリ(EventBridgeのAPI上限)。DynamoDB Streamsの
/// event source mappingのbatchSizeも10に揃えているため(infra側)、通常は1回のPutEvents呼び出し
/// で1バッチ分がまかなえる。
const PUT_EVENTS_BATCH_SIZE: usize = 10;
const EVENT_SOURCE: &str = "account-service";

/// DynamoDB Streams event source mappingの部分バッチ失敗応答
/// ([AWS公式ドキュメント](https://docs.aws.amazon.com/lambda/latest/dg/example_serverless_DynamoDB_Lambda_batch_item_failures_section.html))。
/// `itemIdentifier`にはストリームレコードの`sequenceNumber`を指定する。
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

/// `account_events`のDynamoDB Streams(NEW_IMAGE)から届いたレコードをEventBridgeへ発行する
/// (docs/adr/0004・0013: DynamoDB Streams駆動のトランザクショナルアウトボックス)。
///
/// `PutEvents`が失敗したエントリだけを`batchItemFailures`として報告し、Lambdaのevent source
/// mappingにそのレコードだけを再試行させる(docs/adr/0004決定2)。成功したエントリを再度
/// 報告することはなく、この関数の途中で丸ごと失敗しても「発行したのに未発行のまま」には
/// ならない——最悪でも重複発行に倒れる(at-least-once、docs/adr/0002と同じ設計思想)。
async fn handle_batch(
    eventbridge: &aws_sdk_eventbridge::Client,
    event_bus_name: &str,
    event: DynamoDbEvent,
) -> Result<StreamBatchResponse, Error> {
    let mut failures = Vec::new();

    for chunk in event.records.chunks(PUT_EVENTS_BATCH_SIZE) {
        let mut entries = Vec::with_capacity(chunk.len());
        let mut sequence_numbers = Vec::with_capacity(chunk.len());

        for record in chunk {
            let Some(unpublished) = unpublished_event_from_record(record) else {
                tracing::warn!(event_id = %record.event_id, "skipping stream record without a usable NEW_IMAGE");
                continue;
            };
            let outbox::OutboxEntry { detail_type, detail } = outbox::to_outbox_entry(&unpublished);
            entries.push(
                PutEventsRequestEntry::builder()
                    .event_bus_name(event_bus_name)
                    .source(EVENT_SOURCE)
                    .detail_type(detail_type)
                    .detail(serde_json::to_string(&detail)?)
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

/// `account_events`アイテムのNEW_IMAGE形状(docs/adr/0013決定3、`persistence.rs`の
/// `event_put`が書き込む属性名と対応させる)。`serde_dynamo`がDynamoDBの属性値表現から
/// 直接デシリアライズする。
#[derive(Debug, Deserialize)]
struct EventImage {
    #[serde(rename = "eventId")]
    event_id: Uuid,
    #[serde(rename = "accountId")]
    account_id: Uuid,
    kind: String,
    payload: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "correlationId", default)]
    correlation_id: Option<String>,
}

fn unpublished_event_from_record(record: &EventRecord) -> Option<UnpublishedEvent> {
    let image: EventImage = serde_dynamo::from_item(record.change.new_image.clone())
        .inspect_err(|err| tracing::warn!(%err, "failed to deserialize NEW_IMAGE"))
        .ok()?;
    Some(UnpublishedEvent {
        id: image.event_id,
        account_id: image.account_id,
        kind: image.kind,
        payload: serde_json::from_str(&image.payload).ok()?,
        created_at: OffsetDateTime::parse(&image.created_at, &Rfc3339).ok()?,
        correlation_id: image.correlation_id,
    })
}

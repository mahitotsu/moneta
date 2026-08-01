use std::collections::HashMap;

use account_domain::{AccountId, Event, EventEnvelope};
use aws_lambda_events::eventbridge::EventBridgeEvent;
use aws_sdk_dynamodb::types::AttributeValue;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use query_service::projection;

const EVENT_KIND: &str = "event";

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .without_time()
        .init();

    let table_name = std::env::var("TABLE_NAME").expect("TABLE_NAME environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = aws_sdk_dynamodb::Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<EventBridgeEvent<EventEnvelope>>| {
        let dynamodb = dynamodb.clone();
        let table_name = table_name.clone();
        async move { project_one(&dynamodb, &table_name, event.payload.detail).await }
    }))
    .await
}

/// account-serviceが発行したドメインイベント1件を、Query Serviceのview(DynamoDB)へ冪等に
/// 適用する。アウトボックスはat-least-onceかつ順序無保証で発行しうるため、保存済みより新しい
/// イベントの場合のみ上書きするlast-writer-wins方式を取る(docs/adr/0004。DSQL CDC公式ガイダンス
/// が推奨する方式をそのまま踏襲)。
async fn project_one(
    dynamodb: &aws_sdk_dynamodb::Client,
    table_name: &str,
    envelope: EventEnvelope,
) -> Result<(), Error> {
    if envelope.kind != EVENT_KIND {
        // EventBridge Rule側の購読条件(account.event.*のみ)を満たしていれば通常ここには
        // 来ないが、Query Serviceは購読条件だけに依存させず、境界での防御チェックとして残す
        // (却下(rejection)はviewを変化させないため無視してよい)。
        tracing::warn!(kind = %envelope.kind, "ignoring non-event envelope; rejections don't affect the view");
        return Ok(());
    }

    let event: Event = serde_json::from_value(envelope.data)?;
    let account_id = AccountId::from(envelope.account_id);
    let view = projection::view_from_event(account_id, &event);
    let occurred_at_nanos = envelope.occurred_at.unix_timestamp_nanos().to_string();

    let mut item: HashMap<String, AttributeValue> = HashMap::new();
    item.insert("accountId".to_string(), AttributeValue::S(envelope.account_id.to_string()));
    item.insert("view".to_string(), AttributeValue::S(serde_json::to_string(&view)?));
    item.insert("lastEventAt".to_string(), AttributeValue::N(occurred_at_nanos.clone()));
    item.insert("lastEventId".to_string(), AttributeValue::S(envelope.event_id.to_string()));

    let result = dynamodb
        .put_item()
        .table_name(table_name)
        .set_item(Some(item))
        .condition_expression("attribute_not_exists(accountId) OR lastEventAt < :occurredAt")
        .expression_attribute_values(":occurredAt", AttributeValue::N(occurred_at_nanos))
        .send()
        .await;

    match result {
        Ok(_) => Ok(()),
        Err(err) => {
            let is_stale_or_duplicate = err
                .as_service_error()
                .is_some_and(|service_err| service_err.is_conditional_check_failed_exception());
            if is_stale_or_duplicate {
                // 条件不成立=より新しいイベントが既に反映済み(重複配信または遅延到着)。
                // 最終的にlast-writer-winsで正しい状態に収束するため、エラーではなく正常終了とする。
                tracing::info!(account_id = %envelope.account_id, "skipping stale or duplicate event");
                Ok(())
            } else {
                Err(err.into())
            }
        }
    }
}

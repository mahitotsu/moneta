use auth_service::AuthEventEnvelope;
use aws_lambda_events::cognito::CognitoEventUserPoolsPostConfirmation;
use aws_sdk_eventbridge::Client as EventBridgeClient;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

/// サインアップ完了(Cognitoが確認済みユーザーとして確定した直後)を、既存の
/// `domainEventBus`へ`auth.event.SignedUp`として発行する小さなLambda
/// (docs/adr/0016決定5)。account-serviceのようなDynamoDBアウトボックス
/// (account_events→Streams→PutEvents)は使わない——Cognitoのこのトリガー呼び出し自体が
/// 真実源であり、二重書き込み問題がそもそも存在しないため直接`PutEvents`で足りる。
/// 現時点でこのイベントを購読するサービスはない(発行できることの実証がスコープ、
/// 決定5)。`PutEvents`が失敗してもサインアップ自体は失敗させない(ベストエフォート) ——
/// ログのみに残す。
#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let event_bus_name = std::env::var("POST_CONFIRMATION_EVENT_BUS_NAME")
        .expect("POST_CONFIRMATION_EVENT_BUS_NAME environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let eventbridge = EventBridgeClient::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<CognitoEventUserPoolsPostConfirmation>| {
        let eventbridge = eventbridge.clone();
        let event_bus_name = event_bus_name.clone();
        async move { handler(&eventbridge, &event_bus_name, event).await }
    }))
    .await
}

async fn handler(
    eventbridge: &EventBridgeClient,
    event_bus_name: &str,
    event: LambdaEvent<CognitoEventUserPoolsPostConfirmation>,
) -> Result<CognitoEventUserPoolsPostConfirmation, Error> {
    let payload = event.payload;

    let user_id = payload.request.user_attributes.get("sub").cloned().unwrap_or_default();
    let username = payload.cognito_event_user_pools_header.user_name.clone().unwrap_or_default();

    let envelope = AuthEventEnvelope {
        event_id: uuid::Uuid::new_v4(),
        user_id,
        occurred_at: OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default(),
        data: serde_json::json!({ "username": username }),
    };

    match auth_service::build_entry(event_bus_name, "auth-service", "auth.event.SignedUp", &envelope) {
        Ok(entry) => match eventbridge.put_events().entries(entry).send().await {
            Ok(response) => {
                for result in response.entries() {
                    if let Some(code) = result.error_code() {
                        tracing::error!(
                            error_code = code,
                            error_message = ?result.error_message(),
                            "failed to publish auth.event.SignedUp to EventBridge"
                        );
                    }
                }
            }
            Err(err) => tracing::error!(%err, "failed to publish auth.event.SignedUp to EventBridge"),
        },
        Err(err) => {
            tracing::error!(%err, "failed to serialize auth.event.SignedUp envelope");
        }
    }

    Ok(payload)
}

use auth_service::AuthEventEnvelope;
use aws_lambda_events::cognito::CognitoEventUserPoolsPostAuthentication;
use aws_sdk_eventbridge::Client as EventBridgeClient;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

/// サインイン成功を、既存の`domainEventBus`へ`auth.event.SignedIn`として発行する小さな
/// Lambda(docs/adr/0016決定5)。`post_confirmation.rs`と同じ設計: DynamoDBアウトボックスを
/// 使わずCognitoのこのトリガー呼び出し自体を真実源として直接`PutEvents`し、失敗しても
/// サインイン自体は失敗させない(ベストエフォート、ログのみ)。現時点でこのイベントを
/// 購読するサービスはない(発行できることの実証がスコープ、決定5)。
#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let event_bus_name = std::env::var("POST_AUTHENTICATION_EVENT_BUS_NAME")
        .expect("POST_AUTHENTICATION_EVENT_BUS_NAME environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let eventbridge = EventBridgeClient::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<CognitoEventUserPoolsPostAuthentication>| {
        let eventbridge = eventbridge.clone();
        let event_bus_name = event_bus_name.clone();
        async move { handler(&eventbridge, &event_bus_name, event).await }
    }))
    .await
}

async fn handler(
    eventbridge: &EventBridgeClient,
    event_bus_name: &str,
    event: LambdaEvent<CognitoEventUserPoolsPostAuthentication>,
) -> Result<CognitoEventUserPoolsPostAuthentication, Error> {
    let payload = event.payload;

    let user_id = payload.request.user_attributes.get("sub").cloned().unwrap_or_default();
    let username = payload.cognito_event_user_pools_header.user_name.clone().unwrap_or_default();

    let envelope = AuthEventEnvelope {
        event_id: uuid::Uuid::new_v4(),
        user_id,
        occurred_at: OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default(),
        data: serde_json::json!({ "username": username }),
    };

    match auth_service::build_entry(event_bus_name, "auth-service", "auth.event.SignedIn", &envelope) {
        Ok(entry) => match eventbridge.put_events().entries(entry).send().await {
            Ok(response) => {
                for result in response.entries() {
                    if let Some(code) = result.error_code() {
                        tracing::error!(
                            error_code = code,
                            error_message = ?result.error_message(),
                            "failed to publish auth.event.SignedIn to EventBridge"
                        );
                    }
                }
            }
            Err(err) => tracing::error!(%err, "failed to publish auth.event.SignedIn to EventBridge"),
        },
        Err(err) => {
            tracing::error!(%err, "failed to serialize auth.event.SignedIn envelope");
        }
    }

    Ok(payload)
}

use account_service::handler;
use account_service::persistence::AccountTables;
use lambda_runtime::{run, service_fn, Error};

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .without_time()
        .init();

    let tables = AccountTables {
        accounts: std::env::var("ACCOUNTS_TABLE_NAME").expect("ACCOUNTS_TABLE_NAME environment variable must be set"),
        events: std::env::var("EVENTS_TABLE_NAME").expect("EVENTS_TABLE_NAME environment variable must be set"),
        processed_messages: std::env::var("PROCESSED_MESSAGES_TABLE_NAME")
            .expect("PROCESSED_MESSAGES_TABLE_NAME environment variable must be set"),
    };

    // Lambdaの実行環境が温存されている間、warm invocation間でクライアントを再利用する
    // （毎回接続を張り直さない）。Clientは内部的にArcで共有されるため、クロージャに渡しても
    // 安価。
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let client = aws_sdk_dynamodb::Client::new(&aws_config);

    run(service_fn(move |event| {
        let client = client.clone();
        let tables = tables.clone();
        async move { handler::function_handler(event, client, tables).await }
    }))
    .await
}

mod batch;
mod grouping;
mod handler;
mod persistence;

use lambda_runtime::{run, service_fn, Error};

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .without_time()
        .init();

    // Lambdaの実行環境が温存されている間、warm invocation間でプールを
    // 再利用する（毎回接続を張り直さない）。プールはClone可能で内部的に
    // Arcで共有されるため、クロージャに渡しても安価。
    let database_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL environment variable must be set");
    let pool = aurora_dsql_sqlx_connector::pool::connect(&database_url).await?;

    run(service_fn(move |event| {
        let pool = pool.clone();
        async move { handler::function_handler(event, pool).await }
    }))
    .await
}

use account_domain::{Decimal, Uuid};
use aws_lambda_events::sqs::{SqsBatchResponse, SqsEvent};
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::Deserialize;
use transfer_service::saga::{start, StartError};
use transfer_service::{commands, persistence};

/// クライアント生成の`transferId`をキーにしたSQSメッセージ本文
/// (`account_id`はaccount-serviceのクライアント生成口座IDと同じ考え方、docs/adr/0006決定2)。
#[derive(Debug, Deserialize)]
struct TransferRequest {
    transfer_id: String,
    from_account_id: Uuid,
    to_account_id: Uuid,
    amount: Decimal,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let saga_table_name = std::env::var("SAGA_TABLE_NAME").expect("SAGA_TABLE_NAME environment variable must be set");
    let account_command_queue_url =
        std::env::var("ACCOUNT_COMMAND_QUEUE_URL").expect("ACCOUNT_COMMAND_QUEUE_URL environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = aws_sdk_dynamodb::Client::new(&aws_config);
    let sqs = aws_sdk_sqs::Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<SqsEvent>| {
        let dynamodb = dynamodb.clone();
        let sqs = sqs.clone();
        let saga_table_name = saga_table_name.clone();
        let account_command_queue_url = account_command_queue_url.clone();
        async move {
            process_batch(&dynamodb, &sqs, &saga_table_name, &account_command_queue_url, event.payload).await
        }
    }))
    .await
}

/// 各メッセージは独立した送金の開始要求であり、他のメッセージとの順序依存が無いため
/// (account-serviceのように同一aggregateへの直列化が必要な操作ではない)、account-service
/// のgrouping.rs/batch.rsのようなグループ単位の失敗スコープは不要——メッセージ単位で
/// 独立に成否を報告するだけでよい。
async fn process_batch(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    saga_table_name: &str,
    account_command_queue_url: &str,
    event: SqsEvent,
) -> Result<SqsBatchResponse, Error> {
    let mut failed_message_ids = Vec::new();

    for record in event.records {
        let Some(message_id) = record.message_id.clone() else { continue };
        let body = record.body.as_deref().unwrap_or_default();

        match process_one(dynamodb, sqs, saga_table_name, account_command_queue_url, body).await {
            Ok(()) => {}
            Err(ProcessError::Rejected(reason)) => {
                // account-domainのDomainErrorと同じ扱い: 決定論的に確定した拒否であり、
                // リトライしても結果は変わらないためSQSには失敗として報告しない(docs/adr/0002
                // 決定1と同じ考え方)。
                tracing::warn!(%message_id, ?reason, "transfer request rejected; not retrying");
            }
            Err(ProcessError::Infra(err)) => {
                tracing::error!(%message_id, %err, "infra failure starting transfer; will be retried");
                failed_message_ids.push(message_id);
            }
        }
    }

    let mut response = SqsBatchResponse::default();
    response.set_failures(failed_message_ids);
    Ok(response)
}

enum ProcessError {
    Rejected(StartError),
    Infra(Error),
}

impl From<aws_sdk_dynamodb::Error> for ProcessError {
    fn from(err: aws_sdk_dynamodb::Error) -> Self {
        ProcessError::Infra(err.into())
    }
}

impl From<aws_sdk_sqs::Error> for ProcessError {
    fn from(err: aws_sdk_sqs::Error) -> Self {
        ProcessError::Infra(err.into())
    }
}

async fn process_one(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    saga_table_name: &str,
    account_command_queue_url: &str,
    body: &str,
) -> Result<(), ProcessError> {
    let request: TransferRequest = serde_json::from_str(body).map_err(|err| ProcessError::Infra(err.into()))?;

    let (saga, action) = start(request.transfer_id.clone(), request.from_account_id, request.to_account_id, request.amount)
        .map_err(ProcessError::Rejected)?;

    let created = persistence::create_new_saga(dynamodb, saga_table_name, &saga).await?;
    if !created {
        // 既に存在する = at-least-once配信による重複。最初の配信で既に出金コマンドを
        // 発行済みのはずなので、ここでは何もしない(冪等)。
        tracing::info!(transfer_id = %saga.transfer_id, "duplicate transfer request; already started");
        return Ok(());
    }

    let transfer_service::saga::NextAction::IssueWithdraw { account_id, amount } = action else {
        unreachable!("start() always returns IssueWithdraw as its first action");
    };
    commands::send_withdraw(sqs, account_command_queue_url, account_id, amount, &saga.transfer_id).await?;

    Ok(())
}

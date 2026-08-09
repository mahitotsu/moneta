use account_domain::{Command, Decimal, Uuid};
use aws_sdk_sqs::Client;
use serde::Serialize;

/// account-serviceのSQS FIFOキューへ送るメッセージ本文の形。account-serviceの
/// `AccountCommandEnvelope`(`persistence.rs`)と同じJSON形状を、コード共有はせず独立に
/// 定義する(api-e2e/support/httpClientと同じ理由——契約を変更したら両方を追随させる)。
/// `command`だけは`account_domain::Command`を直接使うため、コマンドの形自体がドリフトする
/// 心配はない(docs/adr/0010決定1: コマンドAPIを経由せずSQSへ直接送る)。
#[derive(Serialize)]
struct AccountCommandEnvelope<'a> {
    account_id: Uuid,
    command: Command,
    correlation_id: &'a str,
}

/// account-serviceのSQS FIFOキューへ、1件のコマンドを直接`SendMessage`する。
/// `MessageGroupId`は口座ID(account-service側の直列化キー、docs/adr/0002)、
/// `MessageDeduplicationId`はサガのステップ単位で一意な値——サガ自身のLambdaが
/// リトライされても、account-service側で二重にコマンドが処理されることはない
/// (docs/adr/0010決定5)。
async fn send_command(
    sqs: &Client,
    queue_url: &str,
    account_id: Uuid,
    command: Command,
    correlation_id: &str,
    idempotency_key: &str,
) -> Result<(), aws_sdk_sqs::Error> {
    let envelope = AccountCommandEnvelope { account_id, command, correlation_id };
    let body = serde_json::to_string(&envelope).expect("AccountCommandEnvelope serialization is infallible");

    sqs.send_message()
        .queue_url(queue_url)
        .message_group_id(account_id.to_string())
        .message_deduplication_id(idempotency_key)
        .message_body(body)
        .send()
        .await?;
    Ok(())
}

pub async fn send_withdraw(
    sqs: &Client,
    queue_url: &str,
    account_id: Uuid,
    amount: Decimal,
    correlation_id: &str,
) -> Result<(), aws_sdk_sqs::Error> {
    let idempotency_key = format!("{correlation_id}-withdraw");
    send_command(sqs, queue_url, account_id, Command::Withdraw { amount }, correlation_id, &idempotency_key).await
}

pub async fn send_deposit(
    sqs: &Client,
    queue_url: &str,
    account_id: Uuid,
    amount: Decimal,
    correlation_id: &str,
) -> Result<(), aws_sdk_sqs::Error> {
    let idempotency_key = format!("{correlation_id}-deposit");
    send_command(sqs, queue_url, account_id, Command::Deposit { amount }, correlation_id, &idempotency_key).await
}

/// 補償(送金元への逆入金)は通常の入金と発行経路は同じだが、`MessageDeduplicationId`を
/// 区別する専用ヘルパーとして分ける——呼び出し側(saga_step)が取り違えないようにするため。
pub async fn send_compensating_deposit(
    sqs: &Client,
    queue_url: &str,
    account_id: Uuid,
    amount: Decimal,
    correlation_id: &str,
) -> Result<(), aws_sdk_sqs::Error> {
    let idempotency_key = format!("{correlation_id}-compensate");
    send_command(sqs, queue_url, account_id, Command::Deposit { amount }, correlation_id, &idempotency_key).await
}

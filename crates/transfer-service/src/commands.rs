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

// --- fee-service / points-service 宛のコマンド(docs/adr/0024) --------------------------
//
// account-serviceと同じ理由(commands.rsコメント冒頭参照)で、コード共有はせず独立に
// メッセージ形状を定義する。fee-service/points-serviceのどちらもaccount-domainに依存しない
// (docs/adr/0024決定1)ため、`account_domain::Command`のようにコマンド型自体を共有する
// こともできない——JSONの形だけを両側で独立に合わせる。

#[derive(Serialize)]
#[serde(tag = "kind")]
enum FeeCommand {
    ReserveFee { transfer_id: String, owner_id: String, account_id: Uuid, transfer_amount: Decimal },
    RefundFee { transfer_id: String },
}

#[derive(Serialize)]
#[serde(tag = "kind")]
enum PointsCommand {
    // docs/adr/0026: transfer_idを追加(以前はowner_id/amountのみ)——ポイント履歴から
    // 「どの送金による付与か」へ辿れるようにするため(ADR-0021が口座履歴↔送金履歴に付けた
    // 相互リンクと同じ理由)。
    AwardPoints { transfer_id: String, owner_id: String, amount: Decimal },
}

async fn send_fee_command(
    sqs: &Client,
    queue_url: &str,
    owner_id: &str,
    command: FeeCommand,
    idempotency_key: &str,
) -> Result<(), aws_sdk_sqs::Error> {
    let body = serde_json::to_string(&command).expect("FeeCommand serialization is infallible");
    sqs.send_message()
        .queue_url(queue_url)
        .message_group_id(owner_id)
        .message_deduplication_id(idempotency_key)
        .message_body(body)
        .send()
        .await?;
    Ok(())
}

/// `ReservingFee`(docs/adr/0024決定4)に入る際に発行する。`fee_amount`は含まない——手数料の
/// 金額はfee-serviceの内部ロジックが決める(決定2)。
#[allow(clippy::too_many_arguments)]
pub async fn send_reserve_fee(
    sqs: &Client,
    queue_url: &str,
    transfer_id: &str,
    owner_id: &str,
    account_id: Uuid,
    transfer_amount: Decimal,
) -> Result<(), aws_sdk_sqs::Error> {
    let idempotency_key = format!("{transfer_id}-reserve-fee");
    let command = FeeCommand::ReserveFee {
        transfer_id: transfer_id.to_string(),
        owner_id: owner_id.to_string(),
        account_id,
        transfer_amount,
    };
    send_fee_command(sqs, queue_url, owner_id, command, &idempotency_key).await
}

/// 送金が最終的に失敗/補償された場合の手数料原資の巻き戻し(docs/adr/0024決定5)。
/// 結果を待たないfire-and-forceで発行する——`MessageGroupId`は`fee-service`側の
/// `FeeReservationsTable`が`transfer_id`をキーにしているため、ここでは`transfer_id`自体を使う
/// (他のfee-service宛コマンドが`owner_id`単位でグルーピングするのとは意図的に異なる——
/// `RefundFee`は`owner_id`を呼び出し側が覚えていない前提のコマンドであるため)。
pub async fn send_refund_fee(sqs: &Client, queue_url: &str, transfer_id: &str) -> Result<(), aws_sdk_sqs::Error> {
    let idempotency_key = format!("{transfer_id}-refund-fee");
    let command = FeeCommand::RefundFee { transfer_id: transfer_id.to_string() };
    let body = serde_json::to_string(&command).expect("FeeCommand serialization is infallible");
    sqs.send_message()
        .queue_url(queue_url)
        .message_group_id(transfer_id)
        .message_deduplication_id(idempotency_key)
        .message_body(body)
        .send()
        .await?;
    Ok(())
}

/// 振込の着金確定時にポイントを付与する(docs/adr/0024決定7)。`fee-service`を経由せず
/// `points-service`へ直接発行する、結果を待たないfire-and-forget。
pub async fn send_award_points(
    sqs: &Client,
    queue_url: &str,
    transfer_id: &str,
    owner_id: &str,
    amount: Decimal,
) -> Result<(), aws_sdk_sqs::Error> {
    let idempotency_key = format!("{transfer_id}-award-points");
    let command = PointsCommand::AwardPoints { transfer_id: transfer_id.to_string(), owner_id: owner_id.to_string(), amount };
    let body = serde_json::to_string(&command).expect("PointsCommand serialization is infallible");
    sqs.send_message()
        .queue_url(queue_url)
        .message_group_id(owner_id)
        .message_deduplication_id(idempotency_key)
        .message_body(body)
        .send()
        .await?;
    Ok(())
}

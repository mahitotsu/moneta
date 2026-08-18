//! `points-service`宛のコマンド送信(docs/adr/0024決定5)。`transfer-service`の`commands.rs`と
//! 同じ理由でコード共有はせず、`points-service`の`command_intake.rs`が期待するJSON形状だけを
//! 独立に合わせる。

use aws_sdk_sqs::Client;
use rust_decimal::Decimal;
use serde::Serialize;

#[derive(Serialize)]
#[serde(tag = "kind")]
enum PointsCommand {
    ReservePoints { transfer_id: String, owner_id: String, up_to: Decimal },
    RefundPoints { transfer_id: String, owner_id: String, amount: Decimal },
}

async fn send(sqs: &Client, queue_url: &str, owner_id: &str, idempotency_key: &str, command: PointsCommand) -> Result<(), aws_sdk_sqs::Error> {
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

/// `ReserveFee`受信直後に発行する(`reservation::start`が返す`IssueReservePoints`に対応)。
pub async fn send_reserve_points(sqs: &Client, queue_url: &str, transfer_id: &str, owner_id: &str, up_to: Decimal) -> Result<(), aws_sdk_sqs::Error> {
    let idempotency_key = format!("{transfer_id}-reserve-points");
    let command = PointsCommand::ReservePoints { transfer_id: transfer_id.to_string(), owner_id: owner_id.to_string(), up_to };
    send(sqs, queue_url, owner_id, &idempotency_key, command).await
}

/// `RefundFee`受信時、`reservation::refund`が`IssueRefundPoints`を返した場合にのみ発行する。
pub async fn send_refund_points(sqs: &Client, queue_url: &str, transfer_id: &str, owner_id: &str, amount: Decimal) -> Result<(), aws_sdk_sqs::Error> {
    let idempotency_key = format!("{transfer_id}-refund-points");
    let command = PointsCommand::RefundPoints { transfer_id: transfer_id.to_string(), owner_id: owner_id.to_string(), amount };
    send(sqs, queue_url, owner_id, &idempotency_key, command).await
}

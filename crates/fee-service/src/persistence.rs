//! `FeeReservationsTable`(PK=`transferId`、docs/adr/0024決定5)⇄DynamoDB項目の変換と、
//! `reservation.rs`の純粋計算を実際のDynamoDB操作へ橋渡しする層。`points-service`の
//! `persistence.rs`と同じ設計(冪等性は条件付き`Put`/`Update`、`ReserveFee`の結果
//! (`fee.event.FeeReserved`)だけがアウトボックスを経由する、docs/adr/0024決定6)を踏襲する。

use std::str::FromStr;

use aws_sdk_dynamodb::error::SdkError;
use aws_sdk_dynamodb::operation::transact_write_items::TransactWriteItemsError;
use aws_sdk_dynamodb::types::{AttributeValue, Put, TransactWriteItem, Update};
use aws_sdk_dynamodb::Client;
use rust_decimal::Decimal;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

use crate::reservation::{FeeReservation, ReservationState};

pub struct FeeTables {
    pub reservations: String,
    pub events: String,
}

fn state_to_str(state: &ReservationState) -> &'static str {
    match state {
        ReservationState::AwaitingPointsReservation => "awaiting_points_reservation",
        ReservationState::Reserved => "reserved",
        ReservationState::Refunded => "refunded",
    }
}

fn state_from_str(value: &str) -> ReservationState {
    match value {
        "awaiting_points_reservation" => ReservationState::AwaitingPointsReservation,
        "reserved" => ReservationState::Reserved,
        "refunded" => ReservationState::Refunded,
        other => unreachable!("unknown fee reservation state persisted in DynamoDB: {other}"),
    }
}

fn item_to_reservation(item: &std::collections::HashMap<String, AttributeValue>) -> FeeReservation {
    let get_s = |key: &str| -> String {
        item.get(key).and_then(|v| v.as_s().ok()).unwrap_or_else(|| unreachable!("reservation item missing field: {key}")).clone()
    };
    FeeReservation {
        transfer_id: get_s("transferId"),
        owner_id: get_s("ownerId"),
        account_id: Uuid::parse_str(&get_s("accountId")).expect("accountId is always a valid UUID"),
        fee_amount: Decimal::from_str(&get_s("feeAmount")).expect("feeAmount is always a valid decimal string"),
        points_used: Decimal::from_str(&get_s("pointsUsed")).expect("pointsUsed is always a valid decimal string"),
        state: state_from_str(&get_s("state")),
    }
}

/// `ReserveFee`受信時の予約作成。既に存在する場合(at-least-once配信による重複)は`false`を
/// 返す——`transfer-service`の`create_new_saga`と同じ「重複は正常系」という扱い。
pub async fn create_new_reservation(client: &Client, table: &str, reservation: &FeeReservation) -> Result<bool, Box<aws_sdk_dynamodb::Error>> {
    let result = client
        .put_item()
        .table_name(table)
        .item("transferId", AttributeValue::S(reservation.transfer_id.clone()))
        .item("ownerId", AttributeValue::S(reservation.owner_id.clone()))
        .item("accountId", AttributeValue::S(reservation.account_id.to_string()))
        .item("feeAmount", AttributeValue::S(reservation.fee_amount.to_string()))
        .item("pointsUsed", AttributeValue::S(reservation.points_used.to_string()))
        .item("state", AttributeValue::S(state_to_str(&reservation.state).to_string()))
        .condition_expression("attribute_not_exists(transferId)")
        .send()
        .await;

    match result {
        Ok(_) => Ok(true),
        Err(err) => {
            let is_duplicate = err.as_service_error().is_some_and(|e| e.is_conditional_check_failed_exception());
            if is_duplicate { Ok(false) } else { Err(Box::new(err.into())) }
        }
    }
}

pub async fn load_reservation(client: &Client, table: &str, transfer_id: &str) -> Result<Option<FeeReservation>, Box<aws_sdk_dynamodb::Error>> {
    let output = client.get_item().table_name(table).key("transferId", AttributeValue::S(transfer_id.to_string())).send().await.map_err(|e| Box::new(e.into()))?;
    Ok(output.item.as_ref().map(item_to_reservation))
}

/// `PointsReserved`観測を受けて`AwaitingPointsReservation`→`Reserved`のCASと、
/// `fee.event.FeeReserved`アウトボックス項目の書き込みを1回の`TransactWriteItems`で行う
/// (docs/adr/0024決定6: 呼び出し元が待つ応答なのでアウトボックスを経由する)。
/// CASが不成立(重複配信、既にReserved/Refunded)の場合は`false`を返し、呼び出し側は
/// 何も発行しない。
pub async fn advance_to_reserved(
    client: &Client,
    tables: &FeeTables,
    reservation: &FeeReservation,
    points_used: Decimal,
    cash_portion: Decimal,
) -> Result<bool, Box<aws_sdk_dynamodb::Error>> {
    let now = OffsetDateTime::now_utc();
    let update = Update::builder()
        .table_name(&tables.reservations)
        .key("transferId", AttributeValue::S(reservation.transfer_id.clone()))
        .update_expression("SET #s = :next, pointsUsed = :pointsUsed")
        .condition_expression("#s = :expected")
        .expression_attribute_names("#s", "state")
        .expression_attribute_values(":next", AttributeValue::S(state_to_str(&ReservationState::Reserved).to_string()))
        .expression_attribute_values(":expected", AttributeValue::S(state_to_str(&ReservationState::AwaitingPointsReservation).to_string()))
        .expression_attribute_values(":pointsUsed", AttributeValue::S(points_used.to_string()))
        .build()
        .expect("Update is fully populated");

    let data = serde_json::json!({ "FeeReserved": { "cash_portion": cash_portion.to_string(), "points_used": points_used.to_string() } });
    let event_put = Put::builder()
        .table_name(&tables.events)
        .item("eventId", AttributeValue::S(Uuid::new_v4().to_string()))
        .item("accountId", AttributeValue::S(reservation.account_id.to_string()))
        .item("correlationId", AttributeValue::S(reservation.transfer_id.clone()))
        .item("kind", AttributeValue::S("event".to_string()))
        .item("data", AttributeValue::S(data.to_string()))
        .item("occurredAt", AttributeValue::S(now.format(&Rfc3339).expect("OffsetDateTime always formats as RFC3339")))
        .build()
        .expect("Put is fully populated");

    let items = vec![TransactWriteItem::builder().update(update).build(), TransactWriteItem::builder().put(event_put).build()];

    match client.transact_write_items().set_transact_items(Some(items)).send().await {
        Ok(_) => Ok(true),
        Err(err) => classify_cas_error(err),
    }
}

/// `RefundFee`受信時の`Reserved`→`Refunded`のCAS。アウトボックスは経由しない(決定6)。
pub async fn advance_to_refunded(client: &Client, table: &str, transfer_id: &str) -> Result<bool, Box<aws_sdk_dynamodb::Error>> {
    let result = client
        .update_item()
        .table_name(table)
        .key("transferId", AttributeValue::S(transfer_id.to_string()))
        .update_expression("SET #s = :next")
        .condition_expression("#s = :expected")
        .expression_attribute_names("#s", "state")
        .expression_attribute_values(":next", AttributeValue::S(state_to_str(&ReservationState::Refunded).to_string()))
        .expression_attribute_values(":expected", AttributeValue::S(state_to_str(&ReservationState::Reserved).to_string()))
        .send()
        .await;

    match result {
        Ok(_) => Ok(true),
        Err(err) => {
            let is_stale = err.as_service_error().is_some_and(|e| e.is_conditional_check_failed_exception());
            if is_stale { Ok(false) } else { Err(Box::new(err.into())) }
        }
    }
}

fn classify_cas_error(err: SdkError<TransactWriteItemsError, aws_smithy_runtime_api::http::Response>) -> Result<bool, Box<aws_sdk_dynamodb::Error>> {
    const CONDITIONAL_CHECK_FAILED: &str = "ConditionalCheckFailed";
    if let Some(TransactWriteItemsError::TransactionCanceledException(cancel)) = err.as_service_error() {
        if cancel.cancellation_reasons().first().and_then(|r| r.code()) == Some(CONDITIONAL_CHECK_FAILED) {
            tracing::info!("fee reservation already advanced by a concurrent/duplicate delivery; not issuing a command");
            return Ok(false);
        }
    }
    Err(Box::new(err.into()))
}

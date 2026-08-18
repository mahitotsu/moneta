//! `points-service`が発行する`points.event.PointsReserved`をEventBridge経由で観測し、
//! `AwaitingPointsReservation`→`Reserved`へ進めて`fee.event.FeeReserved`を発行する
//! (docs/adr/0024決定4・6)。`transfer-service`の`bin/saga_step.rs`と同じ役割の、
//! fee-service版の観測Lambda。

use fee_service::persistence::{self, FeeTables};
use fee_service::reservation::{points_reserved, NextAction};
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::Deserialize;

/// `points-service`の`bin/outbox_projector.rs`が組み立てる`detail`の形
/// (`account_domain::EventEnvelope`と同じ発想の、points-service独自の最小限の外枠、
/// docs/adr/0024決定1: points-serviceはaccount-domainに依存しない)。
#[derive(Debug, Deserialize, serde::Serialize)]
struct PointsEventDetail {
    owner_id: String,
    correlation_id: String,
    data: serde_json::Value,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let tables = FeeTables {
        reservations: std::env::var("FEE_RESERVATIONS_TABLE_NAME").expect("FEE_RESERVATIONS_TABLE_NAME environment variable must be set"),
        events: std::env::var("FEE_EVENTS_TABLE_NAME").expect("FEE_EVENTS_TABLE_NAME environment variable must be set"),
    };
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = aws_sdk_dynamodb::Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<aws_lambda_events::eventbridge::EventBridgeEvent<PointsEventDetail>>| {
        let dynamodb = dynamodb.clone();
        let tables = FeeTables { reservations: tables.reservations.clone(), events: tables.events.clone() };
        async move { handle_one(&dynamodb, &tables, event.payload.detail).await }
    }))
    .await
}

fn extract_points_used(data: &serde_json::Value) -> Option<rust_decimal::Decimal> {
    use std::str::FromStr;
    data.get("PointsReserved")?.get("points_used")?.as_str().and_then(|s| rust_decimal::Decimal::from_str(s).ok())
}

async fn handle_one(dynamodb: &aws_sdk_dynamodb::Client, tables: &FeeTables, detail: PointsEventDetail) -> Result<(), Error> {
    let transfer_id = detail.correlation_id;

    let Some(reservation) = persistence::load_reservation(dynamodb, &tables.reservations, &transfer_id).await? else {
        tracing::warn!(%transfer_id, owner_id = %detail.owner_id, "no fee reservation found for correlation_id; ignoring");
        return Ok(());
    };

    let Some(points_used) = extract_points_used(&detail.data) else {
        tracing::warn!(%transfer_id, "PointsReserved event missing points_used; ignoring");
        return Ok(());
    };

    let (_, action) = points_reserved(&reservation, points_used);
    match action {
        NextAction::EmitFeeReserved { cash_portion } => {
            let advanced = persistence::advance_to_reserved(dynamodb, tables, &reservation, points_used, cash_portion).await?;
            if !advanced {
                tracing::info!(%transfer_id, "fee reservation already advanced by a concurrent/duplicate delivery; not re-emitting");
            }
        }
        NextAction::None => {
            tracing::info!(%transfer_id, ?reservation.state, "PointsReserved observed for a reservation that isn't awaiting one; ignoring as stale/duplicate");
        }
        NextAction::IssueReservePoints { .. } | NextAction::IssueRefundPoints { .. } => {
            unreachable!("reservation::points_reserved() never returns IssueReservePoints/IssueRefundPoints")
        }
    }
    Ok(())
}

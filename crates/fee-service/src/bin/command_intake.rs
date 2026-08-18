//! `FeeCommandQueue`(docs/adr/0024決定8)から`transfer-service`が発行する`ReserveFee`/
//! `RefundFee`を受け取る。`transfer-service`の`bin/command_intake.rs`と同じ「1メッセージ=
//! 1操作、グルーピング不要」という形——予約は`transfer_id`単位で独立しており、
//! account-serviceのような同一集約への直列化は必要ない。

use fee_service::persistence::{self, FeeTables};
use fee_service::reservation::{self, NextAction};
use rust_decimal::Decimal;
use serde::Deserialize;
use uuid::Uuid;

use aws_lambda_events::sqs::{SqsBatchResponse, SqsEvent};
use lambda_runtime::{run, service_fn, Error, LambdaEvent};

/// `transfer-service`の`commands.rs`(`FeeCommand`)と独立に同形を定義する
/// (account-serviceの`AccountCommandEnvelope`と同じ理由)。
#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum FeeCommand {
    ReserveFee { transfer_id: String, owner_id: String, account_id: Uuid, transfer_amount: Decimal },
    RefundFee { transfer_id: String },
}

#[derive(Clone)]
struct Env {
    tables: std::sync::Arc<FeeTables>,
    points_command_queue_url: String,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let env = Env {
        tables: std::sync::Arc::new(FeeTables {
            reservations: std::env::var("FEE_RESERVATIONS_TABLE_NAME").expect("FEE_RESERVATIONS_TABLE_NAME environment variable must be set"),
            events: std::env::var("FEE_EVENTS_TABLE_NAME").expect("FEE_EVENTS_TABLE_NAME environment variable must be set"),
        }),
        points_command_queue_url: std::env::var("POINTS_COMMAND_QUEUE_URL").expect("POINTS_COMMAND_QUEUE_URL environment variable must be set"),
    };
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = aws_sdk_dynamodb::Client::new(&aws_config);
    let sqs = aws_sdk_sqs::Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<SqsEvent>| {
        let dynamodb = dynamodb.clone();
        let sqs = sqs.clone();
        let env = env.clone();
        async move { process_batch(&dynamodb, &sqs, &env, event.payload).await }
    }))
    .await
}

async fn process_batch(dynamodb: &aws_sdk_dynamodb::Client, sqs: &aws_sdk_sqs::Client, env: &Env, event: SqsEvent) -> Result<SqsBatchResponse, Error> {
    let mut failed_message_ids = Vec::new();

    for record in event.records {
        let Some(message_id) = record.message_id.clone() else { continue };
        let body = record.body.as_deref().unwrap_or_default();

        match process_one(dynamodb, sqs, env, body).await {
            Ok(()) => {}
            Err(err) => {
                tracing::error!(%message_id, %err, "failed to process fee command; will be retried by SQS");
                failed_message_ids.push(message_id);
            }
        }
    }

    let mut response = SqsBatchResponse::default();
    response.set_failures(failed_message_ids);
    Ok(response)
}

async fn process_one(dynamodb: &aws_sdk_dynamodb::Client, sqs: &aws_sdk_sqs::Client, env: &Env, body: &str) -> Result<(), Error> {
    let command: FeeCommand = serde_json::from_str(body)?;

    match command {
        FeeCommand::ReserveFee { transfer_id, owner_id, account_id, transfer_amount } => {
            let (reservation, action) = reservation::start(transfer_id, owner_id, account_id, transfer_amount);
            let created = persistence::create_new_reservation(dynamodb, &env.tables.reservations, &reservation).await?;
            if !created {
                tracing::info!(transfer_id = %reservation.transfer_id, "duplicate ReserveFee; already started");
                return Ok(());
            }
            match action {
                NextAction::IssueReservePoints { owner_id, up_to } => {
                    fee_service::commands::send_reserve_points(sqs, &env.points_command_queue_url, &reservation.transfer_id, &owner_id, up_to)
                        .await?;
                }
                other => unreachable!("reservation::start() only ever returns IssueReservePoints, got {other:?}"),
            }
        }
        FeeCommand::RefundFee { transfer_id } => {
            let Some(existing) = persistence::load_reservation(dynamodb, &env.tables.reservations, &transfer_id).await? else {
                tracing::warn!(%transfer_id, "RefundFee for a transfer_id with no known reservation; ignoring");
                return Ok(());
            };
            let (_, action) = reservation::refund(&existing);
            match action {
                NextAction::IssueRefundPoints { owner_id, amount } => {
                    // reservation::refund()が状態遷移を計算する時点ではまだ永続化していないため、
                    // CASが成立した場合のみコマンドを発行する——`advance_to_refunded`のCASそのものが
                    // 「RefundFeeがまだ処理されていないか」の冪等性チェックを兼ねる
                    // (docs/adr/0024決定5)。
                    let advanced = persistence::advance_to_refunded(dynamodb, &env.tables.reservations, &transfer_id).await?;
                    if advanced {
                        fee_service::commands::send_refund_points(sqs, &env.points_command_queue_url, &transfer_id, &owner_id, amount).await?;
                    } else {
                        tracing::info!(%transfer_id, "RefundFee already processed by a concurrent/duplicate delivery; not issuing a command");
                    }
                }
                NextAction::None => {
                    // pointsUsed=0(全額現金だった)、またはまだAwaitingPointsReservation/既に
                    // Refunded。前者はCASだけ試みる価値があるが後者は無意味なので、CASの成否に
                    // 関わらずここでは何もしない——`advance_to_refunded`のCAS自体は「Reserved
                    // だった場合のみ」成立するため、AwaitingPointsReservation/Refundedからの
                    // 呼び出しでは自然に不成立になり安全側に倒れる。
                    let _ = persistence::advance_to_refunded(dynamodb, &env.tables.reservations, &transfer_id).await?;
                }
                NextAction::IssueReservePoints { .. } | NextAction::EmitFeeReserved { .. } => {
                    unreachable!("reservation::refund() never returns IssueReservePoints/EmitFeeReserved")
                }
            }
        }
    }
    Ok(())
}

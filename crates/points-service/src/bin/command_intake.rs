//! `PointsCommandQueue`(docs/adr/0024決定8)から`ReservePoints`/`RefundPoints`(fee-service発、
//! 決定5)・`AwardPoints`(transfer-service発、決定7)を受け取る。account-serviceの
//! `handler.rs`と同じ楽観ロックのリトライパターンを、SQS FIFOの1メッセージ=1操作という
//! transfer-serviceのcommand_intake.rsに近い形で組み合わせる——points-serviceの操作は
//! account-serviceのように同一集約への直列化(MessageGroupId単位のバッチ処理)を必要としない
//! (1メッセージが1人の顧客の残高だけに触れる独立した操作のため)。

use aws_lambda_events::sqs::{SqsBatchResponse, SqsEvent};
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use points_service::history::HistoryKind;
use points_service::persistence::{self, ApplyError, PointsTables};
use rust_decimal::Decimal;
use serde::Deserialize;
use std::time::Duration;

/// `transfer-service`の`commands.rs`(`FeeCommand`/`PointsCommand`)・`fee-service`が独立に
/// 定義する同形のenumと、コード共有はせずJSON形状だけを合わせる(account-serviceの
/// `AccountCommandEnvelope`と同じ理由)。
// バリアント名の"Points"接尾辞は、送信側(transfer-service/fee-serviceのcommands.rs)が使う
// `kind`タグの文字列と1対1で対応させるためあえて揃えている(短縮するとワイヤー上のタグ名と
// ズレる)。
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum PointsCommand {
    ReservePoints { transfer_id: String, owner_id: String, up_to: Decimal },
    RefundPoints { transfer_id: String, owner_id: String, amount: Decimal },
    // docs/adr/0026: transfer_idを追加(以前はowner_id/amountのみ)——ポイント履歴から
    // 「どの送金による付与か」へ辿れるようにするため(docs/adr/0021が口座履歴↔送金履歴に
    // 付けた相互リンクと同じ理由)。
    AwardPoints { transfer_id: String, owner_id: String, amount: Decimal },
}

const MAX_ATTEMPTS: u32 = 5;
const BASE_DELAY: Duration = Duration::from_millis(20);

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let tables = PointsTables {
        points: std::env::var("POINTS_TABLE_NAME").expect("POINTS_TABLE_NAME environment variable must be set"),
        events: std::env::var("POINTS_EVENTS_TABLE_NAME").expect("POINTS_EVENTS_TABLE_NAME environment variable must be set"),
        idempotency: std::env::var("POINTS_IDEMPOTENCY_TABLE_NAME")
            .expect("POINTS_IDEMPOTENCY_TABLE_NAME environment variable must be set"),
        history: std::env::var("POINTS_HISTORY_TABLE_NAME").expect("POINTS_HISTORY_TABLE_NAME environment variable must be set"),
    };
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = aws_sdk_dynamodb::Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<SqsEvent>| {
        let dynamodb = dynamodb.clone();
        let tables = PointsTables {
            points: tables.points.clone(),
            events: tables.events.clone(),
            idempotency: tables.idempotency.clone(),
            history: tables.history.clone(),
        };
        async move { process_batch(&dynamodb, &tables, event.payload).await }
    }))
    .await
}

async fn process_batch(dynamodb: &aws_sdk_dynamodb::Client, tables: &PointsTables, event: SqsEvent) -> Result<SqsBatchResponse, Error> {
    let mut failed_message_ids = Vec::new();

    for record in event.records {
        let Some(message_id) = record.message_id.clone() else { continue };
        let body = record.body.as_deref().unwrap_or_default();

        match process_one(dynamodb, tables, &message_id, body).await {
            Ok(()) => {}
            Err(err) => {
                tracing::error!(%message_id, %err, "failed to process points command after retries; will be retried by SQS");
                failed_message_ids.push(message_id);
            }
        }
    }

    let mut response = SqsBatchResponse::default();
    response.set_failures(failed_message_ids);
    Ok(response)
}

async fn process_one(dynamodb: &aws_sdk_dynamodb::Client, tables: &PointsTables, message_id: &str, body: &str) -> Result<(), Error> {
    let command: PointsCommand = serde_json::from_str(body)?;

    let mut attempt = 0;
    loop {
        let result = match &command {
            PointsCommand::ReservePoints { transfer_id, owner_id, up_to } => {
                persistence::reserve_points(dynamodb, tables, message_id, transfer_id, owner_id, *up_to).await
            }
            PointsCommand::RefundPoints { transfer_id, owner_id, amount } => {
                tracing::info!(%transfer_id, %owner_id, %amount, "refunding points reserved for a failed/compensated transfer");
                persistence::credit_points(dynamodb, tables, HistoryKind::Refunded, message_id, transfer_id, owner_id, *amount).await
            }
            PointsCommand::AwardPoints { transfer_id, owner_id, amount } => {
                persistence::credit_points(dynamodb, tables, HistoryKind::Awarded, message_id, transfer_id, owner_id, *amount).await
            }
        };

        match result {
            Ok(()) => return Ok(()),
            Err(ApplyError::OptimisticLockConflict) if attempt + 1 < MAX_ATTEMPTS => {
                attempt += 1;
                tracing::warn!(%message_id, attempt, "optimistic lock conflict on points balance; retrying in-Lambda");
                tokio::time::sleep(BASE_DELAY * 2u32.pow(attempt)).await;
            }
            Err(err) => return Err(format!("{err:?}").into()),
        }
    }
}

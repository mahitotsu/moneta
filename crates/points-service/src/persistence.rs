//! `PointsTable`(残高、PK=`ownerId`)⇄DynamoDB項目の変換と、`ledger.rs`の純粋計算を実際の
//! DynamoDB操作へ橋渡しする層。`account-service`の`persistence.rs`(`docs/adr/0002`・`0013`)と
//! 同じ設計を、ポイント台帳という小さなドメインに合わせて再利用する:
//!
//! - 楽観的並行性制御は`version`属性(`account-service`の`accounts`テーブルと同じ)。
//! - 冪等性は専用の`PointsIdempotencyTable`への条件付き`Put`(`account-service`の
//!   `processed_messages`と同じ)。SQS FIFOの`MessageDeduplicationId`は送信時5分間の重複排除
//!   にしか効かず、Lambda側の再配信(可視性タイムアウト超過等)までは防げないため必要。
//! - `ReservePoints`(呼び出し元のfee-serviceが結果を待つ、docs/adr/0024決定6)だけが
//!   アウトボックス(`PointsEventsTable`)へのPutを同じ`TransactWriteItems`に含める。
//!   `AwardPoints`/`RefundPoints`はアウトボックスを経由しない(決定6)。
//!
//! 残高は`account-service`の`balance`と同じ理由でDynamoDBのString型に厳密な10進文字列として
//! 持つ(N型の精度問題を避ける、`rust_decimal`の`serde-with-str`と同じ考え方)——このため
//! DynamoDBの原子的な`ADD`(Number型専用)は使えず、`reserve`同様`credit`も読み込み→CAS書き込みの
//! 形にする。

use std::str::FromStr;

use aws_sdk_dynamodb::error::SdkError;
use aws_sdk_dynamodb::operation::transact_write_items::TransactWriteItemsError;
use aws_sdk_dynamodb::types::{AttributeValue, Put, TransactWriteItem, Update};
use aws_sdk_dynamodb::Client;
use rust_decimal::Decimal;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

use crate::history::{self, HistoryKind};
use crate::ledger;

pub struct PointsTables {
    pub points: String,
    pub events: String,
    pub idempotency: String,
    /// 顧客向けポイント履歴(docs/adr/0026)。`events`(fee-service向けアウトボックス、
    /// `ReservePoints`専用)とは別の独立したテーブル——他サービスは一切読まないため
    /// EventBridgeを経由させず、このテーブルへ直接書く(`events`と同じ`TransactWriteItems`に
    /// 相乗りさせるだけ)。
    pub history: String,
}

/// `query-service`の`query_projector.rs`と同じ「ゼロ埋めナノ秒タイムスタンプ#eventId」の
/// ソートキー技法(時刻順ソート+一意性を両立させる)。コード共有はしていない
/// (points-serviceはquery-serviceに依存しない)。
const NANOS_WIDTH: usize = 20;

/// 楽観ロックの競合(`account-service`の`ApplyCommandError::OptimisticLockConflict`と同じ
/// 位置づけ)。呼び出し側(Lambda glue)でリトライする。
#[derive(Debug)]
pub enum ApplyError {
    OptimisticLockConflict,
    Infra(Box<dyn std::error::Error + Send + Sync>),
}

impl<E: std::error::Error + Send + Sync + 'static> From<SdkError<E, aws_smithy_runtime_api::http::Response>> for ApplyError {
    fn from(err: SdkError<E, aws_smithy_runtime_api::http::Response>) -> Self {
        ApplyError::Infra(Box::new(err))
    }
}

async fn get_balance_and_version(
    client: &Client,
    table: &str,
    owner_id: &str,
) -> Result<(Decimal, Option<i64>), ApplyError> {
    let output = client
        .get_item()
        .table_name(table)
        .key("ownerId", AttributeValue::S(owner_id.to_string()))
        .send()
        .await
        .map_err(ApplyError::from)?;
    match output.item {
        None => Ok((Decimal::ZERO, None)),
        Some(item) => {
            let balance = item
                .get("balance")
                .and_then(|v| v.as_s().ok())
                .and_then(|s| Decimal::from_str(s).ok())
                .unwrap_or(Decimal::ZERO);
            let version = item.get("version").and_then(|v| v.as_n().ok()).and_then(|s| s.parse().ok());
            Ok((balance, version))
        }
    }
}

fn points_write(table: &str, owner_id: &str, new_balance: Decimal, current_version: Option<i64>) -> TransactWriteItem {
    let next_version = current_version.unwrap_or(0) + 1;
    match current_version {
        None => {
            let put = Put::builder()
                .table_name(table)
                .item("ownerId", AttributeValue::S(owner_id.to_string()))
                .item("balance", AttributeValue::S(new_balance.to_string()))
                .item("version", AttributeValue::N(next_version.to_string()))
                .condition_expression("attribute_not_exists(ownerId)")
                .build()
                .expect("Put is fully populated");
            TransactWriteItem::builder().put(put).build()
        }
        Some(expected_version) => {
            let update = Update::builder()
                .table_name(table)
                .key("ownerId", AttributeValue::S(owner_id.to_string()))
                .update_expression("SET balance = :balance, version = :nextVersion")
                .condition_expression("version = :expectedVersion")
                .expression_attribute_values(":balance", AttributeValue::S(new_balance.to_string()))
                .expression_attribute_values(":nextVersion", AttributeValue::N(next_version.to_string()))
                .expression_attribute_values(":expectedVersion", AttributeValue::N(expected_version.to_string()))
                .build()
                .expect("Update is fully populated");
            TransactWriteItem::builder().update(update).build()
        }
    }
}

fn idempotency_put(table: &str, idempotency_key: &str, now: OffsetDateTime) -> TransactWriteItem {
    let put = Put::builder()
        .table_name(table)
        .item("idempotencyKey", AttributeValue::S(idempotency_key.to_string()))
        .item("processedAt", AttributeValue::S(now.format(&Rfc3339).expect("OffsetDateTime always formats as RFC3339")))
        .condition_expression("attribute_not_exists(idempotencyKey)")
        .build()
        .expect("Put is fully populated");
    TransactWriteItem::builder().put(put).build()
}

/// 顧客向けポイント履歴の1件を書く(docs/adr/0026)。`points_reserved_event_put`(fee-service向け
/// アウトボックス)とはPKもテーブルも別——こちらはPK=`ownerId`、SK=ゼロ埋めナノ秒タイムスタンプ
/// +`eventId`(`query-service`の`AccountHistoryTable`と同じ技法)。`entry`属性にRust側で
/// 組み立て済みのJSON文字列を丸ごと持たせ、APIのレスポンスVTLは`#foreach`で連結するだけにする
/// (VTLでのJSON組み立てを避ける、`query-service`の`listTransactionsIntegration`と同じ理由)。
fn history_put(table: &str, owner_id: &str, transfer_id: &str, kind: HistoryKind, amount: Decimal, balance_after: Decimal, now: OffsetDateTime) -> TransactWriteItem {
    let event_id = Uuid::new_v4();
    let entry = history::history_entry(kind, amount, balance_after, transfer_id, now, event_id);
    let sort_key = format!("{:0width$}#{event_id}", now.unix_timestamp_nanos(), width = NANOS_WIDTH);
    let put = Put::builder()
        .table_name(table)
        .item("ownerId", AttributeValue::S(owner_id.to_string()))
        .item("sk", AttributeValue::S(sort_key))
        .item("entry", AttributeValue::S(entry.to_string()))
        .build()
        .expect("Put is fully populated");
    TransactWriteItem::builder().put(put).build()
}

fn points_reserved_event_put(table: &str, owner_id: &str, transfer_id: &str, points_used: Decimal, now: OffsetDateTime) -> TransactWriteItem {
    let data = serde_json::json!({ "PointsReserved": { "points_used": points_used.to_string() } });
    let put = Put::builder()
        .table_name(table)
        .item("eventId", AttributeValue::S(Uuid::new_v4().to_string()))
        .item("ownerId", AttributeValue::S(owner_id.to_string()))
        .item("correlationId", AttributeValue::S(transfer_id.to_string()))
        .item("kind", AttributeValue::S("event".to_string()))
        .item("data", AttributeValue::S(data.to_string()))
        .item("occurredAt", AttributeValue::S(now.format(&Rfc3339).expect("OffsetDateTime always formats as RFC3339")))
        .build()
        .expect("Put is fully populated");
    TransactWriteItem::builder().put(put).build()
}

/// `TransactWriteItems`の失敗を分類する(`account-service`の`classify_transact_error`と同じ
/// 考え方、docs/adr/0013決定2)。`TransactItems`は常に[冪等性チェック, points書き込み,
/// (該当すれば)アウトボックスPut, (該当すれば)履歴Put(docs/adr/0026)]の順に積み、条件式を
/// 持つのは最初の2つだけ(アウトボックスPut・履歴Putは無条件)なので、reasons[0]が条件不成立
/// なら「重複配信」、reasons[1]が条件不成立なら楽観ロックの競合としてリトライ対象にする。
fn classify_transact_error(err: SdkError<TransactWriteItemsError, aws_smithy_runtime_api::http::Response>) -> Result<(), ApplyError> {
    const CONDITIONAL_CHECK_FAILED: &str = "ConditionalCheckFailed";
    if let Some(TransactWriteItemsError::TransactionCanceledException(cancel)) = err.as_service_error() {
        let reasons = cancel.cancellation_reasons();
        if reasons.first().and_then(|r| r.code()) == Some(CONDITIONAL_CHECK_FAILED) {
            tracing::info!("duplicate message delivery detected via idempotency condition; treating as no-op");
            return Ok(());
        }
        if reasons.get(1).and_then(|r| r.code()) == Some(CONDITIONAL_CHECK_FAILED) {
            return Err(ApplyError::OptimisticLockConflict);
        }
    }
    Err(err.into())
}

/// `ReservePoints`を1回試行する。呼び出し側(command_intake.rs)は
/// `Err(ApplyError::OptimisticLockConflict)`を受けたら短いバックオフの後に再試行する
/// (`account-service`のhandler.rsと同じパターン)。原資確保は拒否しない設計(docs/adr/0024
/// 決定3)——`ledger::reserve`が保有ポイント0でも常に成功を返すため、この関数自体もDomainError
/// 相当の却下を返すことはない。
pub async fn reserve_points(
    client: &Client,
    tables: &PointsTables,
    idempotency_key: &str,
    transfer_id: &str,
    owner_id: &str,
    up_to: Decimal,
) -> Result<(), ApplyError> {
    let (balance, current_version) = get_balance_and_version(client, &tables.points, owner_id).await?;
    let outcome = ledger::reserve(balance, up_to);
    let now = OffsetDateTime::now_utc();

    let items = vec![
        idempotency_put(&tables.idempotency, idempotency_key, now),
        points_write(&tables.points, owner_id, outcome.new_balance, current_version),
        points_reserved_event_put(&tables.events, owner_id, transfer_id, outcome.points_used, now),
        history_put(&tables.history, owner_id, transfer_id, HistoryKind::Reserved, outcome.points_used, outcome.new_balance, now),
    ];

    match client.transact_write_items().set_transact_items(Some(items)).send().await {
        Ok(_) => Ok(()),
        Err(err) => classify_transact_error(err),
    }
}

/// `AwardPoints`/`RefundPoints`(どちらも単純な加算、docs/adr/0024決定6)を1回試行する。
/// `events`(fee-service向けアウトボックス)へのPutは行わない——結果を待つ呼び出し元がいない
/// ため(決定6は変更しない)。`kind`は顧客向け履歴(`history`テーブル、docs/adr/0026)にだけ
/// 使い、「付与」と「返却」を区別する。
pub async fn credit_points(
    client: &Client,
    tables: &PointsTables,
    kind: HistoryKind,
    idempotency_key: &str,
    transfer_id: &str,
    owner_id: &str,
    amount: Decimal,
) -> Result<(), ApplyError> {
    let (balance, current_version) = get_balance_and_version(client, &tables.points, owner_id).await?;
    let new_balance = ledger::credit(balance, amount);
    let now = OffsetDateTime::now_utc();

    let items = vec![
        idempotency_put(&tables.idempotency, idempotency_key, now),
        points_write(&tables.points, owner_id, new_balance, current_version),
        history_put(&tables.history, owner_id, transfer_id, kind, amount, new_balance, now),
    ];

    match client.transact_write_items().set_transact_items(Some(items)).send().await {
        Ok(_) => Ok(()),
        Err(err) => classify_transact_error(err),
    }
}

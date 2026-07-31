use account_domain::{Account, AccountId, AccountState, Command, Decimal, FreezeReason, OffsetDateTime, Uuid};
use serde::Deserialize;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

/// SQSメッセージ本文の形式。`MessageGroupId`（=口座ID）はSQS属性側にも
/// 重複して載るが、ここでは本文からドメイン層に渡す値として直接持つ。
#[derive(Debug, Clone, Deserialize)]
pub struct AccountCommandEnvelope {
    pub account_id: Uuid,
    pub command: Command,
}

#[derive(sqlx::FromRow)]
struct AccountRow {
    status: String,
    balance: Decimal,
    frozen_reason: Option<String>,
    frozen_at: Option<OffsetDateTime>,
    closed_at: Option<OffsetDateTime>,
}

fn freeze_reason_to_str(reason: &FreezeReason) -> &'static str {
    match reason {
        FreezeReason::SuspectedFraud => "suspected_fraud",
        FreezeReason::CourtOrder => "court_order",
        FreezeReason::CustomerRequest => "customer_request",
    }
}

fn freeze_reason_from_str(value: &str) -> FreezeReason {
    match value {
        "suspected_fraud" => FreezeReason::SuspectedFraud,
        "court_order" => FreezeReason::CourtOrder,
        "customer_request" => FreezeReason::CustomerRequest,
        other => unreachable!("unknown frozen_reason persisted in DB: {other}"),
    }
}

fn row_to_state(row: &AccountRow) -> AccountState {
    match row.status.as_str() {
        "active" => AccountState::Active { balance: row.balance },
        "frozen" => AccountState::Frozen {
            balance: row.balance,
            reason: freeze_reason_from_str(
                row.frozen_reason
                    .as_deref()
                    .unwrap_or_else(|| unreachable!("frozen account row missing frozen_reason")),
            ),
            frozen_at: row
                .frozen_at
                .unwrap_or_else(|| unreachable!("frozen account row missing frozen_at")),
        },
        "closed" => AccountState::Closed {
            final_balance: row.balance,
            closed_at: row
                .closed_at
                .unwrap_or_else(|| unreachable!("closed account row missing closed_at")),
        },
        other => unreachable!("unknown status persisted in DB: {other}"),
    }
}

struct StateColumns {
    status: &'static str,
    balance: Decimal,
    frozen_reason: Option<&'static str>,
    frozen_at: Option<OffsetDateTime>,
    closed_at: Option<OffsetDateTime>,
}

fn state_to_columns(state: &AccountState) -> StateColumns {
    match state {
        AccountState::Active { balance } => StateColumns {
            status: "active",
            balance: *balance,
            frozen_reason: None,
            frozen_at: None,
            closed_at: None,
        },
        AccountState::Frozen {
            balance,
            reason,
            frozen_at,
        } => StateColumns {
            status: "frozen",
            balance: *balance,
            frozen_reason: Some(freeze_reason_to_str(reason)),
            frozen_at: Some(*frozen_at),
            closed_at: None,
        },
        AccountState::Closed {
            final_balance,
            closed_at,
        } => StateColumns {
            status: "closed",
            balance: *final_balance,
            frozen_reason: None,
            frozen_at: None,
            closed_at: Some(*closed_at),
        },
    }
}

/// 1メッセージの処理本体：冪等性チェック → 現在の状態のロード（存在しなければ
/// `apply_to_absent`、存在すれば`apply`） → 結果（イベントor却下記録）の永続化、
/// を1つのトランザクション内で行う。
///
/// 全てDB操作のみで副作用はない（OCC競合で`transaction_with_retry`から
/// 複数回呼ばれても安全 — docs/adr/0002 決定6）。
pub async fn apply_command(
    tx: &mut Transaction<'_, Postgres>,
    message_id: &str,
    envelope: &AccountCommandEnvelope,
) -> Result<(), sqlx::Error> {
    let inserted = sqlx::query(
        "INSERT INTO processed_messages (message_id, account_id) VALUES ($1, $2) \
         ON CONFLICT (message_id) DO NOTHING",
    )
    .bind(message_id)
    .bind(envelope.account_id)
    .execute(&mut **tx)
    .await?;

    if inserted.rows_affected() == 0 {
        // at-least-once配信による重複。既に適用済みなので何もしない。
        return Ok(());
    }

    let existing: Option<AccountRow> = sqlx::query_as(
        "SELECT status, balance, frozen_reason, frozen_at, closed_at FROM accounts WHERE id = $1",
    )
    .bind(envelope.account_id)
    .fetch_optional(&mut **tx)
    .await?;

    let account_id = AccountId::from(envelope.account_id);
    let now = OffsetDateTime::now_utc();
    let is_new_account = existing.is_none();

    // 口座がまだ存在しない場合のプレースホルダー。`evolve`の`Event::Opened`
    // 分岐は自身の状態を見ないため、状態の中身は使われない。
    let base_account = match existing {
        Some(row) => Account::rehydrate(account_id, row_to_state(&row)),
        None => Account::rehydrate(account_id, AccountState::Active { balance: Decimal::ZERO }),
    };

    let outcome = if is_new_account {
        Account::apply_to_absent(account_id, envelope.command.clone(), now)
    } else {
        base_account.apply(envelope.command.clone(), now)
    };

    match outcome {
        Ok(event) => {
            let new_account = base_account.evolve(&event);
            let columns = state_to_columns(new_account.state());

            if is_new_account {
                sqlx::query(
                    "INSERT INTO accounts (id, status, balance, frozen_reason, frozen_at, closed_at) \
                     VALUES ($1, $2, $3, $4, $5, $6)",
                )
                .bind(envelope.account_id)
                .bind(columns.status)
                .bind(columns.balance)
                .bind(columns.frozen_reason)
                .bind(columns.frozen_at)
                .bind(columns.closed_at)
                .execute(&mut **tx)
                .await?;
            } else {
                sqlx::query(
                    "UPDATE accounts SET status = $1, balance = $2, frozen_reason = $3, \
                     frozen_at = $4, closed_at = $5 WHERE id = $6",
                )
                .bind(columns.status)
                .bind(columns.balance)
                .bind(columns.frozen_reason)
                .bind(columns.frozen_at)
                .bind(columns.closed_at)
                .bind(envelope.account_id)
                .execute(&mut **tx)
                .await?;
            }

            let payload = serde_json::to_value(&event).expect("Event serialization is infallible");
            sqlx::query("INSERT INTO account_events (account_id, kind, payload) VALUES ($1, 'event', $2)")
                .bind(envelope.account_id)
                .bind(payload)
                .execute(&mut **tx)
                .await?;
        }
        Err(domain_error) => {
            let payload =
                serde_json::to_value(&domain_error).expect("DomainError serialization is infallible");
            sqlx::query("INSERT INTO account_events (account_id, kind, payload) VALUES ($1, 'rejection', $2)")
                .bind(envelope.account_id)
                .bind(payload)
                .execute(&mut **tx)
                .await?;
        }
    }

    Ok(())
}

/// account_eventsの1行（アウトボックスリレー用）。`kind`は'event'または'rejection'、
/// `payload`は対応する`Event`/`DomainError`のJSON表現(account-domainのシリアライズ形式そのもの)。
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UnpublishedEvent {
    pub id: Uuid,
    pub account_id: Uuid,
    pub kind: String,
    pub payload: Value,
    pub created_at: OffsetDateTime,
}

/// まだEventBridgeへ発行していない行を古い順に取得する（アウトボックスのポーリング対象）。
pub async fn fetch_unpublished_events(pool: &PgPool, limit: i64) -> Result<Vec<UnpublishedEvent>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, account_id, kind, payload, created_at FROM account_events \
         WHERE published_at IS NULL ORDER BY created_at LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// EventBridgeへの発行が成功した行にpublished_atを記録する。呼び出し順序
/// （PutEvents成功後に呼ぶこと）はoutbox_relay側の責務——先にこちらを呼ぶと、
/// PutEventsが失敗した際にイベントが発行されないまま「発行済み」扱いになり、
/// サイレントなデータロスを起こす（docs/adr/0002と同じ設計思想）。
pub async fn mark_published(pool: &PgPool, event_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE account_events SET published_at = now() WHERE id = $1")
        .bind(event_id)
        .execute(pool)
        .await?;
    Ok(())
}

use std::collections::HashMap;
use std::str::FromStr;

use account_domain::{Account, AccountId, AccountState, Command, Decimal, DomainError, FreezeReason, OffsetDateTime, Rfc3339, Uuid};
use aws_sdk_dynamodb::error::SdkError;
use aws_sdk_dynamodb::operation::transact_write_items::TransactWriteItemsError;
use aws_sdk_dynamodb::types::{AttributeValue, ConditionCheck, Put, TransactWriteItem, Update};
use aws_sdk_dynamodb::Client;
use serde::Deserialize;
use serde_json::Value;

/// SQSメッセージ本文の形式。`MessageGroupId`（=口座ID）はSQS属性側にも
/// 重複して載るが、ここでは本文からドメイン層に渡す値として直接持つ。
#[derive(Debug, Clone, Deserialize)]
pub struct AccountCommandEnvelope {
    pub account_id: Uuid,
    pub command: Command,
    /// コマンド発行元(例: transfer-service)が付与する不透明な相関ID(docs/adr/0010決定4)。
    /// `Command`の一部ではなくエンベロープ側に置くことで、account-domainの状態遷移ロジックを
    /// 一切通さずに`account_events.correlation_id`まで素通しできる。顧客の通常操作では常に
    /// 欠落しており、その場合は`None`として扱う。
    #[serde(default)]
    pub correlation_id: Option<String>,
    /// 認証済みユーザーの識別子(docs/adr/0016)。API Gatewayの`Open`/`Freeze`/`Unfreeze`/
    /// `Close`リソースにつけたVTLが`$context.authorizer.claims.sub`から注入する——顧客が
    /// 送るリクエストボディの一部ではない。外部チャネル(Deposit/Withdraw、認証なし、
    /// ADR-0009決定1)からのメッセージやtransfer-serviceが直接送るメッセージには存在しない。
    #[serde(default)]
    pub requested_by: Option<String>,
}

/// account-serviceが書き込む3テーブルの名前(docs/adr/0013)。
#[derive(Debug, Clone)]
pub struct AccountTables {
    pub accounts: String,
    pub events: String,
    pub processed_messages: String,
}

/// 1メッセージの処理で起こりうる失敗(docs/adr/0002決定1・docs/adr/0013決定2)。
pub enum ApplyCommandError {
    /// 楽観ロックの競合(`accounts`項目の`version`条件不成立)。呼び出し側でリトライする。
    OptimisticLockConflict,
    /// それ以外のインフラ起因の失敗(スロットリング・接続断等)。
    Infra(Box<dyn std::error::Error + Send + Sync>),
}

impl std::fmt::Debug for ApplyCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OptimisticLockConflict => write!(f, "OptimisticLockConflict"),
            Self::Infra(err) => write!(f, "Infra({err:?})"),
        }
    }
}

impl std::fmt::Display for ApplyCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OptimisticLockConflict => write!(f, "optimistic lock conflict"),
            Self::Infra(err) => write!(f, "infra failure: {err}"),
        }
    }
}

impl std::error::Error for ApplyCommandError {}

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
        other => unreachable!("unknown frozen_reason persisted in DynamoDB: {other}"),
    }
}

fn parse_rfc3339(value: &str) -> OffsetDateTime {
    OffsetDateTime::parse(value, &Rfc3339).unwrap_or_else(|_| unreachable!("stored timestamp is not valid RFC3339: {value}"))
}

fn format_rfc3339(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).expect("OffsetDateTime always formats as RFC3339")
}

fn get_s(item: &HashMap<String, AttributeValue>, key: &str) -> Option<String> {
    item.get(key).and_then(|v| v.as_s().ok()).cloned()
}

/// `accounts`アイテム(`ownerId`/`status`/`balance`/...)⇔`AccountState`の変換
/// (docs/adr/0003決定2、docs/adr/0013決定2)。`version`(楽観ロック用)も併せて返す。
fn item_to_state(item: &HashMap<String, AttributeValue>) -> (String, AccountState, i64) {
    let owner_id = get_s(item, "ownerId").unwrap_or_default();
    let status = get_s(item, "status").unwrap_or_else(|| unreachable!("account item missing status"));
    let balance = Decimal::from_str(
        &get_s(item, "balance").unwrap_or_else(|| unreachable!("account item missing balance")),
    )
    .unwrap_or_else(|_| unreachable!("account item balance is not a valid decimal"));
    let version: i64 = item
        .get("version")
        .and_then(|v| v.as_n().ok())
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| unreachable!("account item missing version"));

    let state = match status.as_str() {
        "active" => AccountState::Active { balance },
        "frozen" => AccountState::Frozen {
            balance,
            reason: freeze_reason_from_str(
                &get_s(item, "frozenReason").unwrap_or_else(|| unreachable!("frozen account item missing frozenReason")),
            ),
            frozen_at: parse_rfc3339(
                &get_s(item, "frozenAt").unwrap_or_else(|| unreachable!("frozen account item missing frozenAt")),
            ),
        },
        "closed" => AccountState::Closed {
            final_balance: balance,
            closed_at: parse_rfc3339(
                &get_s(item, "closedAt").unwrap_or_else(|| unreachable!("closed account item missing closedAt")),
            ),
        },
        other => unreachable!("unknown status persisted in DynamoDB: {other}"),
    };
    (owner_id, state, version)
}

struct StateAttributes {
    status: &'static str,
    balance: Decimal,
    frozen_reason: Option<&'static str>,
    frozen_at: Option<OffsetDateTime>,
    closed_at: Option<OffsetDateTime>,
}

fn state_to_attributes(state: &AccountState) -> StateAttributes {
    match state {
        AccountState::Active { balance } => StateAttributes {
            status: "active",
            balance: *balance,
            frozen_reason: None,
            frozen_at: None,
            closed_at: None,
        },
        AccountState::Frozen { balance, reason, frozen_at } => StateAttributes {
            status: "frozen",
            balance: *balance,
            frozen_reason: Some(freeze_reason_to_str(reason)),
            frozen_at: Some(*frozen_at),
            closed_at: None,
        },
        AccountState::Closed { final_balance, closed_at } => StateAttributes {
            status: "closed",
            balance: *final_balance,
            frozen_reason: None,
            frozen_at: None,
            closed_at: Some(*closed_at),
        },
    }
}

fn account_key(account_id: Uuid) -> HashMap<String, AttributeValue> {
    HashMap::from([("accountId".to_string(), AttributeValue::S(account_id.to_string()))])
}

async fn get_account_item(
    client: &Client,
    table: &str,
    account_id: Uuid,
) -> Result<Option<HashMap<String, AttributeValue>>, aws_sdk_dynamodb::Error> {
    let output = client.get_item().table_name(table).set_key(Some(account_key(account_id))).send().await?;
    Ok(output.item)
}

/// `processed_messages`への冪等性チェック用Put。`messageId`が既に存在すれば
/// `ConditionalCheckFailed`で失敗する——at-least-once配信による重複を検出する
/// (docs/adr/0002決定4)。
fn processed_message_put(table: &str, message_id: &str, account_id: Uuid, now: OffsetDateTime) -> TransactWriteItem {
    let put = Put::builder()
        .table_name(table)
        .item("messageId", AttributeValue::S(message_id.to_string()))
        .item("accountId", AttributeValue::S(account_id.to_string()))
        .item("processedAt", AttributeValue::S(format_rfc3339(now)))
        .condition_expression("attribute_not_exists(messageId)")
        .build()
        .expect("Put is fully populated");
    TransactWriteItem::builder().put(put).build()
}

/// `accounts`への書き込み(コマンドが受理された場合)。新規口座は`attribute_not_exists`、
/// 既存口座は`version`の等値条件で楽観ロックする(docs/adr/0013決定2)。
fn account_write(
    table: &str,
    account_id: Uuid,
    owner_id: &str,
    state: &AccountState,
    current_version: Option<i64>,
) -> TransactWriteItem {
    let attrs = state_to_attributes(state);
    let next_version = current_version.unwrap_or(0) + 1;

    match current_version {
        None => {
            let mut builder = Put::builder()
                .table_name(table)
                .item("accountId", AttributeValue::S(account_id.to_string()))
                .item("ownerId", AttributeValue::S(owner_id.to_string()))
                .item("status", AttributeValue::S(attrs.status.to_string()))
                .item("balance", AttributeValue::S(attrs.balance.to_string()))
                .item("version", AttributeValue::N(next_version.to_string()))
                .condition_expression("attribute_not_exists(accountId)");
            if let Some(reason) = attrs.frozen_reason {
                builder = builder.item("frozenReason", AttributeValue::S(reason.to_string()));
            }
            if let Some(t) = attrs.frozen_at {
                builder = builder.item("frozenAt", AttributeValue::S(format_rfc3339(t)));
            }
            if let Some(t) = attrs.closed_at {
                builder = builder.item("closedAt", AttributeValue::S(format_rfc3339(t)));
            }
            TransactWriteItem::builder().put(builder.build().expect("Put is fully populated")).build()
        }
        Some(expected_version) => {
            let mut set_parts = vec![
                "#status = :status".to_string(),
                "balance = :balance".to_string(),
                "#version = :nextVersion".to_string(),
            ];
            let mut remove_parts = Vec::new();
            let mut values: HashMap<String, AttributeValue> = HashMap::from([
                (":status".to_string(), AttributeValue::S(attrs.status.to_string())),
                (":balance".to_string(), AttributeValue::S(attrs.balance.to_string())),
                (":nextVersion".to_string(), AttributeValue::N(next_version.to_string())),
                (":expectedVersion".to_string(), AttributeValue::N(expected_version.to_string())),
            ]);

            match attrs.frozen_reason {
                Some(reason) => {
                    set_parts.push("frozenReason = :frozenReason".to_string());
                    values.insert(":frozenReason".to_string(), AttributeValue::S(reason.to_string()));
                }
                None => remove_parts.push("frozenReason".to_string()),
            }
            match attrs.frozen_at {
                Some(t) => {
                    set_parts.push("frozenAt = :frozenAt".to_string());
                    values.insert(":frozenAt".to_string(), AttributeValue::S(format_rfc3339(t)));
                }
                None => remove_parts.push("frozenAt".to_string()),
            }
            match attrs.closed_at {
                Some(t) => {
                    set_parts.push("closedAt = :closedAt".to_string());
                    values.insert(":closedAt".to_string(), AttributeValue::S(format_rfc3339(t)));
                }
                None => remove_parts.push("closedAt".to_string()),
            }

            let mut update_expression = format!("SET {}", set_parts.join(", "));
            if !remove_parts.is_empty() {
                update_expression.push_str(&format!(" REMOVE {}", remove_parts.join(", ")));
            }

            let update = Update::builder()
                .table_name(table)
                .set_key(Some(account_key(account_id)))
                .update_expression(update_expression)
                .condition_expression("#version = :expectedVersion")
                .expression_attribute_names("#status", "status")
                .expression_attribute_names("#version", "version")
                .set_expression_attribute_values(Some(values))
                .build()
                .expect("Update is fully populated");
            TransactWriteItem::builder().update(update).build()
        }
    }
}

/// `accounts`への書き込みなしにOCC条件だけを検証する(コマンドが却下された場合)。
/// DomainErrorの判定は読み込んだ時点のスナップショットに基づくため、その後に別の
/// メッセージが同じ口座を変更していないことを確認してから却下を確定する——確認できなければ
/// 楽観ロックの競合としてリトライする(docs/adr/0013決定2)。
fn account_condition_check(table: &str, account_id: Uuid, current_version: Option<i64>) -> TransactWriteItem {
    let mut builder = ConditionCheck::builder().table_name(table).set_key(Some(account_key(account_id)));
    builder = match current_version {
        None => builder.condition_expression("attribute_not_exists(accountId)"),
        Some(expected_version) => builder
            .condition_expression("#version = :expectedVersion")
            .expression_attribute_names("#version", "version")
            .expression_attribute_values(":expectedVersion", AttributeValue::N(expected_version.to_string())),
    };
    TransactWriteItem::builder().condition_check(builder.build().expect("ConditionCheck is fully populated")).build()
}

/// `account_events`への追記(docs/adr/0013決定3のアウトボックス)。`eventId`は毎回新規の
/// UUIDであり、他の項目と主キーが衝突しないため条件式は不要。
fn event_put(
    table: &str,
    account_id: Uuid,
    kind: &str,
    payload: &Value,
    now: OffsetDateTime,
    correlation_id: Option<&str>,
) -> TransactWriteItem {
    let mut builder = Put::builder()
        .table_name(table)
        .item("eventId", AttributeValue::S(Uuid::new_v4().to_string()))
        .item("accountId", AttributeValue::S(account_id.to_string()))
        .item("kind", AttributeValue::S(kind.to_string()))
        .item("payload", AttributeValue::S(payload.to_string()))
        .item("createdAt", AttributeValue::S(format_rfc3339(now)));
    if let Some(correlation_id) = correlation_id {
        builder = builder.item("correlationId", AttributeValue::S(correlation_id.to_string()));
    }
    TransactWriteItem::builder().put(builder.build().expect("Put is fully populated")).build()
}

/// `TransactWriteItems`の失敗を分類する(docs/adr/0013決定2)。DynamoDBは条件不成立を
/// `ConditionalCheckFailedException`としてではなく、`TransactionCanceledException`の
/// `CancellationReasons`(`TransactItems`と同じ並び)として返す
/// ([AWS公式ドキュメント](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)で確認済み)。
/// `TransactItems`は常に[冪等性チェック, accounts書き込み/条件チェック, イベント挿入]の順に
/// 積んでいるため、reasons[0]が条件不成立なら「重複配信」(却下ではなく正常系、
/// docs/adr/0002決定1と同じ考え方)、reasons[1]が条件不成立なら楽観ロックの競合として
/// リトライ対象にする。
fn classify_transact_error(
    err: SdkError<TransactWriteItemsError, aws_smithy_runtime_api::http::Response>,
) -> Result<(), ApplyCommandError> {
    const CONDITIONAL_CHECK_FAILED: &str = "ConditionalCheckFailed";

    if let Some(TransactWriteItemsError::TransactionCanceledException(cancel)) = err.as_service_error() {
        let reasons = cancel.cancellation_reasons();
        if reasons.first().and_then(|r| r.code()) == Some(CONDITIONAL_CHECK_FAILED) {
            tracing::info!("duplicate message delivery detected via processed_messages condition; treating as no-op");
            return Ok(());
        }
        if reasons.get(1).and_then(|r| r.code()) == Some(CONDITIONAL_CHECK_FAILED) {
            return Err(ApplyCommandError::OptimisticLockConflict);
        }
    }
    Err(ApplyCommandError::Infra(Box::new(err)))
}

/// Openはボディのowner_idを信用せず、`requested_by`(API Gateway VTLが
/// `$context.authorizer.claims.sub`から注入する、Cognito認証済みユーザーのsub)があれば
/// それで上書きする(docs/adr/0016)——認証済みだが他人のowner_idを名乗って口座を開設する、
/// というなりすましを防ぐ。`requested_by`が無い(Open以外、またはVTL非経由の呼び出し)場合は
/// 元のコマンドをそのまま返す。
fn resolve_owner_id(command: Command, requested_by: Option<&str>) -> Command {
    match (command, requested_by) {
        (Command::Open { initial_balance, .. }, Some(requested_by)) => {
            Command::Open { owner_id: requested_by.to_string(), initial_balance }
        }
        (command, _) => command,
    }
}

/// Freeze/Unfreeze/Closeは、既存口座の名義(`current_owner_id`)と`requested_by`が一致しない
/// 限りNotOwnerとして却下する(docs/adr/0016、他人の口座を操作させない)。口座がまだ存在しない
/// 場合(`is_new_account`)は`apply_to_absent`が従来通り`AccountNotFound`を返すべきなので対象外
/// にする——存在しない口座の`current_owner_id`はプレースホルダーの空文字列であり、比較すると
/// 誤検知する。`requested_by`が無い(Deposit/Withdraw、外部チャネル・認証なし、ADR-0009決定1)
/// 場合もチェックしない。
fn is_ownership_violation(command: &Command, is_new_account: bool, current_owner_id: &str, requested_by: Option<&str>) -> bool {
    !is_new_account
        && matches!(command, Command::Freeze { .. } | Command::Unfreeze | Command::Close)
        && requested_by.is_some_and(|requested_by| requested_by != current_owner_id)
}

/// 1メッセージの処理本体：現在の状態のロード（存在しなければ`apply_to_absent`、存在すれば
/// `apply`） → 結果（イベントor却下記録）の永続化を1回の`TransactWriteItems`で行う
/// (docs/adr/0002・0013)。
///
/// 全てDB操作のみで副作用はない（楽観ロック競合で呼び出し側から複数回呼ばれても安全
/// — docs/adr/0002決定6・0013決定2）。
pub async fn apply_command(
    client: &Client,
    tables: &AccountTables,
    message_id: &str,
    envelope: &AccountCommandEnvelope,
) -> Result<(), ApplyCommandError> {
    let existing = get_account_item(client, &tables.accounts, envelope.account_id)
        .await
        .map_err(|err| ApplyCommandError::Infra(Box::new(err)))?;

    let account_id = AccountId::from(envelope.account_id);
    let now = OffsetDateTime::now_utc();
    let is_new_account = existing.is_none();

    // 口座がまだ存在しない場合のプレースホルダー。`evolve`の`Event::Opened`
    // 分岐は自身の状態(owner_idも含む)を見ないため、中身は使われない。
    let (base_account, current_version) = match &existing {
        Some(item) => {
            let (owner_id, state, version) = item_to_state(item);
            (Account::rehydrate(account_id, owner_id, state), Some(version))
        }
        None => (Account::rehydrate(account_id, String::new(), AccountState::Active { balance: Decimal::ZERO }), None),
    };

    // 認可(docs/adr/0016)。AWS依存のない純粋関数に切り出してunit testできるようにする
    // (このcrateの既存方針: classify_transact_error等と同じくロジック部分だけを分離する)。
    let command = resolve_owner_id(envelope.command.clone(), envelope.requested_by.as_deref());
    let ownership_violation =
        is_ownership_violation(&command, is_new_account, base_account.owner_id(), envelope.requested_by.as_deref());

    let outcome = if ownership_violation {
        Err(DomainError::NotOwner)
    } else if is_new_account {
        Account::apply_to_absent(account_id, command, now)
    } else {
        base_account.apply(command, now)
    };

    let (kind, payload) = match &outcome {
        Ok(event) => ("event", serde_json::to_value(event).expect("Event serialization is infallible")),
        Err(domain_error) => {
            ("rejection", serde_json::to_value(domain_error).expect("DomainError serialization is infallible"))
        }
    };

    let mut items = Vec::with_capacity(3);
    items.push(processed_message_put(&tables.processed_messages, message_id, envelope.account_id, now));

    match &outcome {
        Ok(event) => {
            let new_account = base_account.evolve(event);
            items.push(account_write(
                &tables.accounts,
                envelope.account_id,
                new_account.owner_id(),
                new_account.state(),
                current_version,
            ));
        }
        Err(_) => {
            items.push(account_condition_check(&tables.accounts, envelope.account_id, current_version));
        }
    }

    items.push(event_put(&tables.events, envelope.account_id, kind, &payload, now, envelope.correlation_id.as_deref()));

    match client.transact_write_items().set_transact_items(Some(items)).send().await {
        Ok(_) => Ok(()),
        Err(err) => classify_transact_error(err),
    }
}

/// `account_events`の1件(アウトボックス用)。DynamoDB Streamsが配信するNEW_IMAGEから
/// 組み立てる(docs/adr/0013決定3、`bin/account_outbox_projector.rs`)。
#[derive(Debug, Clone)]
pub struct UnpublishedEvent {
    pub id: Uuid,
    pub account_id: Uuid,
    pub kind: String,
    pub payload: Value,
    pub created_at: OffsetDateTime,
    pub correlation_id: Option<String>,
}

#[cfg(test)]
mod ownership_tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn open_command_owner_id_is_overridden_by_requested_by_when_present() {
        let command = Command::Open { owner_id: "claimed-by-body".to_string(), initial_balance: dec!(100) };
        let resolved = resolve_owner_id(command, Some("real-cognito-sub"));
        assert_eq!(resolved, Command::Open { owner_id: "real-cognito-sub".to_string(), initial_balance: dec!(100) });
    }

    #[test]
    fn open_command_owner_id_is_kept_when_requested_by_is_absent() {
        // 外部からの直接SQS送信等、VTLを経由しない呼び出し(現状は存在しないが、将来の
        // 呼び出し元を壊さないための後方互換)。
        let command = Command::Open { owner_id: "body-owner".to_string(), initial_balance: dec!(100) };
        let resolved = resolve_owner_id(command, None);
        assert_eq!(resolved, Command::Open { owner_id: "body-owner".to_string(), initial_balance: dec!(100) });
    }

    #[test]
    fn non_open_commands_are_never_modified() {
        let command = Command::Withdraw { amount: dec!(10) };
        assert_eq!(resolve_owner_id(command.clone(), Some("someone")), command);
    }

    #[test]
    fn freeze_unfreeze_close_are_violations_when_requested_by_does_not_match_the_owner() {
        for command in [Command::Freeze { reason: FreezeReason::CustomerRequest }, Command::Unfreeze, Command::Close] {
            assert!(is_ownership_violation(&command, false, "actual-owner", Some("someone-else")));
            assert!(!is_ownership_violation(&command, false, "actual-owner", Some("actual-owner")));
        }
    }

    #[test]
    fn ownership_is_not_checked_when_the_account_does_not_exist_yet() {
        // 存在しない口座へのFreeze/Unfreeze/Closeは、認可チェックではなく
        // apply_to_absentのAccountNotFoundに委ねる(base_accountのowner_idは
        // プレースホルダーの空文字列なので、ここで誤ってNotOwnerにしない)。
        assert!(!is_ownership_violation(&Command::Close, true, "", Some("someone")));
    }

    #[test]
    fn ownership_is_not_checked_when_requested_by_is_absent() {
        // Deposit/Withdrawと同じ「外部チャネル」経路をFreeze等が通ることは実際にはないが、
        // requested_by自体が無い限りチェックしない、という関数の契約を単体で固定する。
        assert!(!is_ownership_violation(&Command::Close, false, "actual-owner", None));
    }

    #[test]
    fn deposit_and_withdraw_are_never_ownership_violations() {
        assert!(!is_ownership_violation(&Command::Deposit { amount: dec!(10) }, false, "actual-owner", Some("someone-else")));
        assert!(!is_ownership_violation(&Command::Withdraw { amount: dec!(10) }, false, "actual-owner", Some("someone-else")));
    }
}

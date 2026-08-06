use std::collections::HashMap;
use std::str::FromStr;

use account_domain::{Decimal, OffsetDateTime, Rfc3339, Uuid};
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client;

use crate::saga::{SagaState, TransferKind, TransferSaga};

/// `TransferSaga` ⇄ DynamoDB項目の変換は、account-serviceの`persistence.rs`の
/// `row_to_state`/`state_to_columns`と同じ役割で、ここだけに置く。
fn state_to_str(state: &SagaState) -> &'static str {
    match state {
        SagaState::PendingConfirmation => "pending_confirmation",
        SagaState::PendingDebit => "pending_debit",
        SagaState::PendingCredit => "pending_credit",
        SagaState::Compensating => "compensating",
        SagaState::Credited => "credited",
        SagaState::Compensated => "compensated",
        SagaState::Failed => "failed",
        SagaState::Cancelled => "cancelled",
    }
}

fn state_from_str(value: &str) -> SagaState {
    match value {
        "pending_confirmation" => SagaState::PendingConfirmation,
        "pending_debit" => SagaState::PendingDebit,
        "pending_credit" => SagaState::PendingCredit,
        "compensating" => SagaState::Compensating,
        "credited" => SagaState::Credited,
        "compensated" => SagaState::Compensated,
        "failed" => SagaState::Failed,
        "cancelled" => SagaState::Cancelled,
        other => unreachable!("unknown saga state persisted in DynamoDB: {other}"),
    }
}

fn kind_to_str(kind: TransferKind) -> &'static str {
    match kind {
        TransferKind::Furikae => "furikae",
        TransferKind::Furikomi => "furikomi",
        TransferKind::Recall => "recall",
    }
}

fn kind_from_str(value: &str) -> TransferKind {
    match value {
        "furikae" => TransferKind::Furikae,
        "furikomi" => TransferKind::Furikomi,
        "recall" => TransferKind::Recall,
        other => unreachable!("unknown transfer kind persisted in DynamoDB: {other}"),
    }
}

fn saga_to_item(saga: &TransferSaga) -> HashMap<String, AttributeValue> {
    let mut item = HashMap::new();
    item.insert("transferId".to_string(), AttributeValue::S(saga.transfer_id.clone()));
    item.insert("fromAccountId".to_string(), AttributeValue::S(saga.from_account_id.to_string()));
    item.insert("toAccountId".to_string(), AttributeValue::S(saga.to_account_id.to_string()));
    item.insert("amount".to_string(), AttributeValue::S(saga.amount.to_string()));
    item.insert("kind".to_string(), AttributeValue::S(kind_to_str(saga.kind).to_string()));
    item.insert("state".to_string(), AttributeValue::S(state_to_str(&saga.state).to_string()));
    item.insert(
        "updatedAt".to_string(),
        AttributeValue::S(saga.updated_at.format(&Rfc3339).expect("OffsetDateTime always formats as RFC3339")),
    );
    item
}

fn item_to_saga(item: &HashMap<String, AttributeValue>) -> TransferSaga {
    let get_s = |key: &str| -> String {
        item.get(key)
            .and_then(|v| v.as_s().ok())
            .unwrap_or_else(|| unreachable!("saga item missing string field: {key}"))
            .clone()
    };
    TransferSaga {
        transfer_id: get_s("transferId"),
        from_account_id: Uuid::parse_str(&get_s("fromAccountId")).expect("fromAccountId is always a valid UUID"),
        to_account_id: Uuid::parse_str(&get_s("toAccountId")).expect("toAccountId is always a valid UUID"),
        amount: Decimal::from_str(&get_s("amount")).expect("amount is always a valid decimal string"),
        kind: kind_from_str(&get_s("kind")),
        state: state_from_str(&get_s("state")),
        updated_at: OffsetDateTime::parse(&get_s("updatedAt"), &Rfc3339).expect("updatedAt is always valid RFC3339"),
    }
}

/// 新しいサガを作成する。「まだ存在しない場合のみ」を条件にすることで、コマンド受付Lambda
/// (`transfer-command-intake`)がat-least-once配信で再実行されても、同じ送金を2度
/// 開始しない(冪等性)。戻り値`false`は「既に存在した(重複配信)」を示す——エラーではなく
/// 正常系として扱う(query-serviceのlast-writer-wins方式と同じ考え方)。
pub async fn create_new_saga(
    client: &Client,
    table_name: &str,
    saga: &TransferSaga,
) -> Result<bool, aws_sdk_dynamodb::Error> {
    let result = client
        .put_item()
        .table_name(table_name)
        .set_item(Some(saga_to_item(saga)))
        .condition_expression("attribute_not_exists(transferId)")
        .send()
        .await;

    match result {
        Ok(_) => Ok(true),
        Err(err) => {
            let is_duplicate =
                err.as_service_error().is_some_and(|service_err| service_err.is_conditional_check_failed_exception());
            if is_duplicate { Ok(false) } else { Err(err.into()) }
        }
    }
}

pub async fn load_saga(
    client: &Client,
    table_name: &str,
    transfer_id: &str,
) -> Result<Option<TransferSaga>, aws_sdk_dynamodb::Error> {
    let output = client
        .get_item()
        .table_name(table_name)
        .key("transferId", AttributeValue::S(transfer_id.to_string()))
        .send()
        .await?;
    Ok(output.item.as_ref().map(item_to_saga))
}

/// `expected_current`のままであれば`next`へ更新する(楽観的並行性制御)。既に別の配信で
/// 先へ進んでいた場合(EventBridgeのat-least-once配信による重複イベント)は条件不成立になり、
/// `false`を返す——エラーではなく「何もしなかった」として扱う。`updatedAt`も同時に書く
/// (`Credited`到達時刻の代用として`recall_eligibility`が使う、docs/adr/0011)。
pub async fn advance_saga_state(
    client: &Client,
    table_name: &str,
    transfer_id: &str,
    expected_current: &SagaState,
    next: &SagaState,
    now: OffsetDateTime,
) -> Result<bool, aws_sdk_dynamodb::Error> {
    let result = client
        .update_item()
        .table_name(table_name)
        .key("transferId", AttributeValue::S(transfer_id.to_string()))
        .update_expression("SET #s = :next, updatedAt = :now")
        .condition_expression("#s = :expected")
        .expression_attribute_names("#s", "state")
        .expression_attribute_values(":next", AttributeValue::S(state_to_str(next).to_string()))
        .expression_attribute_values(":expected", AttributeValue::S(state_to_str(expected_current).to_string()))
        .expression_attribute_values(
            ":now",
            AttributeValue::S(now.format(&Rfc3339).expect("OffsetDateTime always formats as RFC3339")),
        )
        .send()
        .await;

    match result {
        Ok(_) => Ok(true),
        Err(err) => {
            let is_stale =
                err.as_service_error().is_some_and(|service_err| service_err.is_conditional_check_failed_exception());
            if is_stale { Ok(false) } else { Err(err.into()) }
        }
    }
}

// --- 口座名義インデックス(docs/adr/0011) -----------------------------------------------
//
// `account.event.Opened`だけを購読する専用の小さな投影(`bin/owner_projector.rs`)が書き込み、
// `command_intake.rs`が振替/振込の判定のために読む。名義は開設時から不変なので、
// query-serviceのAccountViewTableのような「洗い替え」方式の投影は不要——1回書いたら
// 二度と更新しない。

pub async fn save_owner(
    client: &Client,
    table_name: &str,
    account_id: Uuid,
    owner_id: &str,
) -> Result<(), aws_sdk_dynamodb::Error> {
    client
        .put_item()
        .table_name(table_name)
        .item("accountId", AttributeValue::S(account_id.to_string()))
        .item("ownerId", AttributeValue::S(owner_id.to_string()))
        .send()
        .await?;
    Ok(())
}

/// 名義がまだ見つからない場合は`Ok(None)`を返す(エラーではない)。呼び出し側
/// (`command_intake.rs`)はこれを「口座が存在しない」ではなく「まだこの投影に反映されて
/// いないだけかもしれない(結果整合性の遅延)」として扱い、却下ではなく再試行する
/// (docs/adr/0011、[[eventual_consistency_not_a_failure]]と同じ考え方)。
pub async fn load_owner(
    client: &Client,
    table_name: &str,
    account_id: Uuid,
) -> Result<Option<String>, aws_sdk_dynamodb::Error> {
    let output = client
        .get_item()
        .table_name(table_name)
        .key("accountId", AttributeValue::S(account_id.to_string()))
        .send()
        .await?;
    Ok(output.item.as_ref().and_then(|item| item.get("ownerId")).and_then(|v| v.as_s().ok()).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn saga_round_trips_through_dynamodb_item_representation() {
        let saga = TransferSaga {
            transfer_id: "transfer-1".to_string(),
            from_account_id: Uuid::new_v4(),
            to_account_id: Uuid::new_v4(),
            amount: dec!(1234.56),
            kind: TransferKind::Furikomi,
            state: SagaState::PendingCredit,
            updated_at: OffsetDateTime::UNIX_EPOCH,
        };
        let item = saga_to_item(&saga);
        assert_eq!(item_to_saga(&item), saga);
    }

    #[test]
    fn saga_round_trips_for_every_kind_and_state() {
        for kind in [TransferKind::Furikae, TransferKind::Furikomi, TransferKind::Recall] {
            for state in [
                SagaState::PendingConfirmation,
                SagaState::PendingDebit,
                SagaState::PendingCredit,
                SagaState::Compensating,
                SagaState::Credited,
                SagaState::Compensated,
                SagaState::Failed,
                SagaState::Cancelled,
            ] {
                let saga = TransferSaga {
                    transfer_id: "t".to_string(),
                    from_account_id: Uuid::new_v4(),
                    to_account_id: Uuid::new_v4(),
                    amount: dec!(100),
                    kind,
                    state,
                    updated_at: OffsetDateTime::UNIX_EPOCH,
                };
                let item = saga_to_item(&saga);
                assert_eq!(item_to_saga(&item), saga);
            }
        }
    }
}

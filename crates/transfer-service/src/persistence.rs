use std::collections::HashMap;
use std::str::FromStr;

use account_domain::{Decimal, Uuid};
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client;

use crate::saga::{SagaState, TransferSaga};

/// `TransferSaga` ⇄ DynamoDB項目の変換は、account-serviceの`persistence.rs`の
/// `row_to_state`/`state_to_columns`と同じ役割で、ここだけに置く。
fn state_to_str(state: &SagaState) -> &'static str {
    match state {
        SagaState::PendingDebit => "pending_debit",
        SagaState::PendingCredit => "pending_credit",
        SagaState::Compensating => "compensating",
        SagaState::Credited => "credited",
        SagaState::Compensated => "compensated",
        SagaState::Failed => "failed",
    }
}

fn state_from_str(value: &str) -> SagaState {
    match value {
        "pending_debit" => SagaState::PendingDebit,
        "pending_credit" => SagaState::PendingCredit,
        "compensating" => SagaState::Compensating,
        "credited" => SagaState::Credited,
        "compensated" => SagaState::Compensated,
        "failed" => SagaState::Failed,
        other => unreachable!("unknown saga state persisted in DynamoDB: {other}"),
    }
}

fn saga_to_item(saga: &TransferSaga) -> HashMap<String, AttributeValue> {
    let mut item = HashMap::new();
    item.insert("transferId".to_string(), AttributeValue::S(saga.transfer_id.clone()));
    item.insert("fromAccountId".to_string(), AttributeValue::S(saga.from_account_id.to_string()));
    item.insert("toAccountId".to_string(), AttributeValue::S(saga.to_account_id.to_string()));
    item.insert("amount".to_string(), AttributeValue::S(saga.amount.to_string()));
    item.insert("state".to_string(), AttributeValue::S(state_to_str(&saga.state).to_string()));
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
        state: state_from_str(&get_s("state")),
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
/// `false`を返す——エラーではなく「何もしなかった」として扱う。
pub async fn advance_saga_state(
    client: &Client,
    table_name: &str,
    transfer_id: &str,
    expected_current: &SagaState,
    next: &SagaState,
) -> Result<bool, aws_sdk_dynamodb::Error> {
    let result = client
        .update_item()
        .table_name(table_name)
        .key("transferId", AttributeValue::S(transfer_id.to_string()))
        .update_expression("SET #s = :next")
        .condition_expression("#s = :expected")
        .expression_attribute_names("#s", "state")
        .expression_attribute_values(":next", AttributeValue::S(state_to_str(next).to_string()))
        .expression_attribute_values(":expected", AttributeValue::S(state_to_str(expected_current).to_string()))
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
            state: SagaState::PendingCredit,
        };
        let item = saga_to_item(&saga);
        assert_eq!(item_to_saga(&item), saga);
    }
}

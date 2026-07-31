use account_domain::{Account, AccountId, AccountState, Decimal, Event, FreezeReason};
use serde_json::{json, Value};

/// ドメインイベントから、Query APIが返すview(口座の現在状態)を導出する。`Event`自身の情報だけで
/// 結果の`AccountState`が決まる(`account-domain::Account::evolve`は`self`の既存状態を参照しない)
/// ため、呼び出し前の状態を持つ必要はない——プレースホルダーの`Account`を経由して`evolve`を再利用し、
/// 状態遷移ロジックの複製を避ける。
pub fn view_from_event(account_id: AccountId, event: &Event) -> Value {
    let placeholder = Account::rehydrate(account_id, AccountState::Active { balance: Decimal::ZERO });
    state_to_view(placeholder.evolve(event).state())
}

/// account-serviceの`persistence::state_to_columns`とは別物。あちらはaccount-service自身の
/// DB行への変換、こちらはQuery Serviceが呼び出し元に返すviewスキーマへの変換であり、
/// 依存する理由・変更される理由が異なる(docs/adr/0004のサービス境界を参照)。
fn state_to_view(state: &AccountState) -> Value {
    match state {
        AccountState::Active { balance } => json!({
            "status": "active",
            "balance": balance,
            "frozenReason": Value::Null,
            "frozenAt": Value::Null,
            "closedAt": Value::Null,
        }),
        AccountState::Frozen { balance, reason, frozen_at } => json!({
            "status": "frozen",
            "balance": balance,
            "frozenReason": freeze_reason_label(reason),
            "frozenAt": frozen_at,
            "closedAt": Value::Null,
        }),
        AccountState::Closed { final_balance, closed_at } => json!({
            "status": "closed",
            "balance": final_balance,
            "frozenReason": Value::Null,
            "frozenAt": Value::Null,
            "closedAt": closed_at,
        }),
    }
}

fn freeze_reason_label(reason: &FreezeReason) -> &'static str {
    match reason {
        FreezeReason::SuspectedFraud => "suspected_fraud",
        FreezeReason::CourtOrder => "court_order",
        FreezeReason::CustomerRequest => "customer_request",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use account_domain::OffsetDateTime;
    use rust_decimal_macros::dec;

    #[test]
    fn deposited_event_yields_active_view_with_new_balance() {
        let event = Event::Deposited {
            account_id: AccountId::new(),
            amount: dec!(500),
            new_balance: dec!(1500),
        };
        let view = view_from_event(AccountId::new(), &event);
        assert_eq!(view["status"], "active");
        assert_eq!(view["balance"], json!(dec!(1500)));
        assert_eq!(view["frozenReason"], Value::Null);
    }

    #[test]
    fn frozen_event_yields_frozen_view_with_reason() {
        let event = Event::Frozen {
            account_id: AccountId::new(),
            balance: dec!(100),
            reason: FreezeReason::CourtOrder,
            frozen_at: OffsetDateTime::UNIX_EPOCH,
        };
        let view = view_from_event(AccountId::new(), &event);
        assert_eq!(view["status"], "frozen");
        assert_eq!(view["frozenReason"], "court_order");
    }

    #[test]
    fn closed_event_yields_closed_view_with_final_balance() {
        let event = Event::Closed {
            account_id: AccountId::new(),
            final_balance: dec!(0),
            closed_at: OffsetDateTime::UNIX_EPOCH,
        };
        let view = view_from_event(AccountId::new(), &event);
        assert_eq!(view["status"], "closed");
        assert_eq!(view["balance"], json!(dec!(0)));
    }
}

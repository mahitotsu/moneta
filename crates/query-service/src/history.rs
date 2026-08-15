use account_domain::{Event, OffsetDateTime, Uuid};
use serde_json::{json, Value};

use crate::projection::{format_timestamp, freeze_reason_label};

/// ドメインイベント1件を、取引履歴の1エントリ(Query APIの`GET .../transactions`が返す
/// 配列の要素)へ変換する。`projection::view_from_event`(現在状態のview)とは別の、
/// 第二のread model(docs/adr/0009)——ADR-0004が確立したイベント駆動投影パターンの延長。
///
/// `occurred_at`/`event_id`は`Event`自身ではなく`EventEnvelope`(発行側の契約、
/// docs/adr/0008)から渡される。`Event::Deposited`/`Withdrawn`はそれ自身のタイムスタンプを
/// 持たないため、全種別で統一してエンベロープ側の値を使う。
pub fn history_entry_from_event(event: &Event, occurred_at: OffsetDateTime, event_id: Uuid) -> Value {
    let (kind, amount, balance_after, reason) = match event {
        Event::Opened { balance, .. } => ("opened", Value::Null, *balance, None),
        Event::Deposited { amount, new_balance, .. } => ("deposited", json!(amount), *new_balance, None),
        Event::Withdrawn { amount, new_balance, .. } => ("withdrawn", json!(amount), *new_balance, None),
        Event::Frozen { balance, reason, .. } => ("frozen", Value::Null, *balance, Some(freeze_reason_label(reason))),
        Event::Unfrozen { balance, .. } => ("unfrozen", Value::Null, *balance, None),
        Event::Closed { final_balance, .. } => ("closed", Value::Null, *final_balance, None),
    };

    json!({
        "type": kind,
        "amount": amount,
        "balanceAfter": balance_after,
        "occurredAt": format_timestamp(occurred_at),
        "eventId": event_id,
        "reason": reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use account_domain::{AccountId, FreezeReason};
    use rust_decimal_macros::dec;

    fn envelope_fields() -> (OffsetDateTime, Uuid) {
        (OffsetDateTime::UNIX_EPOCH, Uuid::new_v4())
    }

    #[test]
    fn opened_event_yields_opened_entry_with_no_amount() {
        let (occurred_at, event_id) = envelope_fields();
        let event = Event::Opened {
            account_id: AccountId::new(),
            owner_id: "customer-1".to_string(),
            owner_name: "Customer One".to_string(),
            balance: dec!(1000),
            opened_at: occurred_at,
        };
        let entry = history_entry_from_event(&event, occurred_at, event_id);
        assert_eq!(entry["type"], "opened");
        assert_eq!(entry["amount"], Value::Null);
        assert_eq!(entry["balanceAfter"], json!(dec!(1000)));
        assert_eq!(entry["eventId"], json!(event_id));
    }

    #[test]
    fn deposited_event_yields_deposited_entry_with_amount() {
        let (occurred_at, event_id) = envelope_fields();
        let event = Event::Deposited { account_id: AccountId::new(), amount: dec!(500), new_balance: dec!(1500) };
        let entry = history_entry_from_event(&event, occurred_at, event_id);
        assert_eq!(entry["type"], "deposited");
        assert_eq!(entry["amount"], json!(dec!(500)));
        assert_eq!(entry["balanceAfter"], json!(dec!(1500)));
    }

    #[test]
    fn frozen_event_yields_frozen_entry_with_reason_and_no_amount() {
        let (occurred_at, event_id) = envelope_fields();
        let event = Event::Frozen {
            account_id: AccountId::new(),
            balance: dec!(100),
            reason: FreezeReason::CourtOrder,
            frozen_at: occurred_at,
        };
        let entry = history_entry_from_event(&event, occurred_at, event_id);
        assert_eq!(entry["type"], "frozen");
        assert_eq!(entry["amount"], Value::Null);
        assert_eq!(entry["reason"], "court_order");
        // Same regression guard as projection.rs: occurredAt must be RFC3339, not `time`'s
        // default serde format (which JS's `new Date(...)` can't parse).
        let occurred_at_str = entry["occurredAt"].as_str().expect("occurredAt should be a string");
        account_domain::OffsetDateTime::parse(occurred_at_str, &account_domain::Rfc3339)
            .expect("occurredAt should be valid RFC3339");
    }

    #[test]
    fn closed_event_yields_closed_entry_with_final_balance() {
        let (occurred_at, event_id) = envelope_fields();
        let event = Event::Closed { account_id: AccountId::new(), final_balance: dec!(0), closed_at: occurred_at };
        let entry = history_entry_from_event(&event, occurred_at, event_id);
        assert_eq!(entry["type"], "closed");
        assert_eq!(entry["balanceAfter"], json!(dec!(0)));
    }
}

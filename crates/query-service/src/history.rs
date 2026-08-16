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
///
/// `correlation_id`も同じく`EventEnvelope`由来(docs/adr/0010決定4)。transfer-serviceが
/// Deposit/Withdrawを発行した際のtransferIdがそのまま入っており、それ以外(顧客の直接操作・
/// 外部チャネル)では`None`。`transferId`としてそのままエントリに載せる(docs/adr/0021)
/// ——この入出金が振込/振替/組戻しのどれによって起きたものかを、送金の詳細へのリンクとして
/// 顧客向けUIから辿れるようにするためだけの、輸送専用の値。`account-domain`自身はこの値を
/// 一切知らず、Event::Deposited/Withdrawn自体には含まれない(envelope.rsの設計をそのまま踏襲)。
///
/// `channel`も同じ由来(docs/adr/0023)。外部チャネル・エミュレータ(ATM/他行からの振込/
/// 収納機関への支払い)経由のDeposit/Withdrawにだけ付与され、`correlation_id`(transfer-service
/// 経由)とは互いに排他——両方同時に値を持つことはない。`channel`としてそのままエントリに
/// 載せ、顧客向けUIが「入金」「出金」に発生源のラベルを添えるために使う。
pub fn history_entry_from_event(
    event: &Event,
    occurred_at: OffsetDateTime,
    event_id: Uuid,
    correlation_id: Option<&str>,
    channel: Option<&str>,
) -> Value {
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
        "transferId": correlation_id,
        "channel": channel,
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
        let entry = history_entry_from_event(&event, occurred_at, event_id, None, None);
        assert_eq!(entry["type"], "opened");
        assert_eq!(entry["amount"], Value::Null);
        assert_eq!(entry["balanceAfter"], json!(dec!(1000)));
        assert_eq!(entry["eventId"], json!(event_id));
        assert_eq!(entry["transferId"], Value::Null);
    }

    #[test]
    fn deposited_event_yields_deposited_entry_with_amount() {
        let (occurred_at, event_id) = envelope_fields();
        let event = Event::Deposited { account_id: AccountId::new(), amount: dec!(500), new_balance: dec!(1500) };
        let entry = history_entry_from_event(&event, occurred_at, event_id, None, None);
        assert_eq!(entry["type"], "deposited");
        assert_eq!(entry["amount"], json!(dec!(500)));
        assert_eq!(entry["balanceAfter"], json!(dec!(1500)));
    }

    /// docs/adr/0021: transfer-service経由のDeposit/Withdraw(correlation_id = transferId)は
    /// エントリに`transferId`として素通しされ、送金の詳細へのリンクに使われる。
    #[test]
    fn deposited_event_with_correlation_id_carries_transfer_id() {
        let (occurred_at, event_id) = envelope_fields();
        let event = Event::Deposited { account_id: AccountId::new(), amount: dec!(500), new_balance: dec!(1500) };
        let entry = history_entry_from_event(&event, occurred_at, event_id, Some("transfer-123"), None);
        assert_eq!(entry["transferId"], "transfer-123");
    }

    /// docs/adr/0023: 外部チャネル・エミュレータ経由のDeposit/Withdraw(channelあり、
    /// correlation_idなし)は`channel`としてエントリに素通しされる。
    #[test]
    fn deposited_event_with_channel_carries_channel_and_no_transfer_id() {
        let (occurred_at, event_id) = envelope_fields();
        let event = Event::Deposited { account_id: AccountId::new(), amount: dec!(500), new_balance: dec!(1500) };
        let entry = history_entry_from_event(&event, occurred_at, event_id, None, Some("Atm"));
        assert_eq!(entry["channel"], "Atm");
        assert_eq!(entry["transferId"], Value::Null);
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
        let entry = history_entry_from_event(&event, occurred_at, event_id, None, None);
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
        let entry = history_entry_from_event(&event, occurred_at, event_id, None, None);
        assert_eq!(entry["type"], "closed");
        assert_eq!(entry["balanceAfter"], json!(dec!(0)));
    }
}

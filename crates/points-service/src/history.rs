//! ポイント履歴の1エントリ(`GET /customers/me/points/history`が返す配列の要素)を組み立てる
//! 純粋関数(docs/adr/0026)。`query-service`の`history.rs`(取引履歴、docs/adr/0009)と同じ
//! 役割・同じ形——DynamoDBのVTLでJSONを組み立てる(ADR-0006が実機バグを繰り返し踏んだ経緯が
//! ある)代わりに、Rust側で1エントリ分のJSON文字列を事前に組み立てて`entry`属性としてそのまま
//! 持たせ、APIのレスポンスVTLは`#foreach`でその文字列を連結するだけにする。
//!
//! `query-service`とはコードを共有しない(`points-service`はaccount-domainにもquery-serviceにも
//! 依存しない、docs/adr/0024決定1)——形だけ独立して合わせる。

use rust_decimal::Decimal;
use serde_json::{json, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

/// ポイント残高を動かす3種類の操作(docs/adr/0024)。`amount`は常に非負の増減幅で持ち、
/// 「増えたか減ったか」はこの`kind`だけで表現する——`reserved`(手数料への充当、減る)、
/// `awarded`(振込着金による付与、増える)、`refunded`(送金失敗/補償による返却、増える)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryKind {
    Reserved,
    Awarded,
    Refunded,
}

impl HistoryKind {
    fn as_str(self) -> &'static str {
        match self {
            HistoryKind::Reserved => "reserved",
            HistoryKind::Awarded => "awarded",
            HistoryKind::Refunded => "refunded",
        }
    }
}

pub fn history_entry(
    kind: HistoryKind,
    amount: Decimal,
    balance_after: Decimal,
    transfer_id: &str,
    occurred_at: OffsetDateTime,
    event_id: Uuid,
) -> Value {
    json!({
        "type": kind.as_str(),
        "amount": amount,
        "balanceAfter": balance_after,
        "occurredAt": occurred_at.format(&Rfc3339).expect("OffsetDateTime always formats as RFC3339"),
        "eventId": event_id,
        "transferId": transfer_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn fields() -> (OffsetDateTime, Uuid) {
        (OffsetDateTime::UNIX_EPOCH, Uuid::new_v4())
    }

    #[test]
    fn reserved_entry_carries_its_kind_amount_and_transfer_id() {
        let (occurred_at, event_id) = fields();
        let entry = history_entry(HistoryKind::Reserved, dec!(100), dec!(120), "transfer-1", occurred_at, event_id);
        assert_eq!(entry["type"], "reserved");
        assert_eq!(entry["amount"], json!(dec!(100)));
        assert_eq!(entry["balanceAfter"], json!(dec!(120)));
        assert_eq!(entry["transferId"], "transfer-1");
        assert_eq!(entry["eventId"], json!(event_id));
    }

    #[test]
    fn awarded_entry_has_the_awarded_kind() {
        let (occurred_at, event_id) = fields();
        let entry = history_entry(HistoryKind::Awarded, dec!(3), dec!(23), "transfer-2", occurred_at, event_id);
        assert_eq!(entry["type"], "awarded");
    }

    #[test]
    fn refunded_entry_has_the_refunded_kind() {
        let (occurred_at, event_id) = fields();
        let entry = history_entry(HistoryKind::Refunded, dec!(220), dec!(220), "transfer-3", occurred_at, event_id);
        assert_eq!(entry["type"], "refunded");
    }

    #[test]
    fn occurred_at_is_rfc3339_not_times_default_serde_format() {
        // query-serviceのhistory.rsが持つ同種の回帰ガードと同じ理由(JS Date()がパースできる
        // 形式であることの確認)。
        let (occurred_at, event_id) = fields();
        let entry = history_entry(HistoryKind::Awarded, dec!(1), dec!(1), "t", occurred_at, event_id);
        let occurred_at_str = entry["occurredAt"].as_str().expect("occurredAt should be a string");
        OffsetDateTime::parse(occurred_at_str, &Rfc3339).expect("occurredAt should be valid RFC3339");
    }
}

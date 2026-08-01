use account_domain::EventEnvelope;
use serde_json::Value;

use crate::persistence::UnpublishedEvent;

/// EventBridgeへ発行する1エントリの中身。
pub struct OutboxEntry {
    pub detail_type: String,
    pub detail: EventEnvelope,
}

/// account_eventsの1行を、EventBridgeのPutEventsエントリの形に変換する。
pub fn to_outbox_entry(event: &UnpublishedEvent) -> OutboxEntry {
    let variant = variant_name(&event.payload);
    OutboxEntry {
        detail_type: format!("account.{}.{}", event.kind, variant),
        detail: EventEnvelope {
            event_id: event.id,
            account_id: event.account_id,
            occurred_at: event.created_at,
            kind: event.kind.clone(),
            data: event.payload.clone(),
        },
    }
}

/// account-domainのEvent/DomainErrorはserdeのデフォルト(外部タグ)表現でシリアライズされる:
/// unitバリアントはJSON文字列(例: "AccountClosed")、それ以外はキーが1つのオブジェクト
/// (例: {"Deposited": {...}})。どちらの形からもバリアント名を取り出す。
fn variant_name(payload: &Value) -> String {
    match payload {
        Value::String(name) => name.clone(),
        Value::Object(map) => map.keys().next().cloned().unwrap_or_else(|| "unknown".to_string()),
        _ => "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use account_domain::{OffsetDateTime, Uuid};
    use serde_json::json;

    fn unpublished_event(kind: &str, payload: Value) -> UnpublishedEvent {
        UnpublishedEvent {
            id: Uuid::new_v4(),
            account_id: Uuid::new_v4(),
            kind: kind.to_string(),
            payload,
            created_at: OffsetDateTime::UNIX_EPOCH,
        }
    }

    #[test]
    fn struct_variant_payload_yields_variant_name_as_detail_type_suffix() {
        let event = unpublished_event("event", json!({"Deposited": {"amount": "500"}}));
        let entry = to_outbox_entry(&event);
        assert_eq!(entry.detail_type, "account.event.Deposited");
    }

    #[test]
    fn unit_variant_payload_yields_variant_name_as_detail_type_suffix() {
        let event = unpublished_event("rejection", json!("AccountClosed"));
        let entry = to_outbox_entry(&event);
        assert_eq!(entry.detail_type, "account.rejection.AccountClosed");
    }

    #[test]
    fn detail_carries_event_id_account_id_and_raw_payload() {
        let event = unpublished_event("event", json!({"Deposited": {"amount": "500"}}));
        let entry = to_outbox_entry(&event);
        assert_eq!(entry.detail.event_id, event.id);
        assert_eq!(entry.detail.account_id, event.account_id);
        assert_eq!(entry.detail.data, json!({"Deposited": {"amount": "500"}}));
    }

    #[test]
    fn event_envelope_round_trips_through_json() {
        let event = unpublished_event("event", json!({"Deposited": {"amount": "500"}}));
        let entry = to_outbox_entry(&event);
        let json = serde_json::to_string(&entry.detail).unwrap();
        let round_tripped: EventEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(round_tripped, entry.detail);
    }
}

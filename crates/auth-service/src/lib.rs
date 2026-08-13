/// account-domainのEventEnvelopeと同じ形(docs/adr/0016決定5)だが、account_idではなく
/// user_id(Cognitoのsub)を持つ独立した型——auth-serviceはaccount-domainに依存しない
/// (docs/adr/0003のcrate境界の考え方をそのまま踏襲、認証はアカウントのドメインとは
/// 独立の関心事)。
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthEventEnvelope {
    pub event_id: uuid::Uuid,
    pub user_id: String,
    pub occurred_at: String, // RFC3339文字列(account_domain::Rfc3339と同じ理由、JSの`new Date()`が
    // パースできる形。time::OffsetDateTimeのformat(&Rfc3339)の呼び出しは
    // 呼び出し側(各bin)で行い、ここには文字列として渡す)。
    pub data: serde_json::Value,
}

/// `AuthEventEnvelope`をJSONシリアライズし、EventBridgeの`PutEvents`エントリを組み立てる。
/// account-serviceのアウトボックス(`outbox::to_outbox_entry` + プロジェクターの
/// `PutEventsRequestEntry::builder()`呼び出し)と同じ形だが、auth-serviceには別テーブルの
/// アウトボックスが存在しない(docs/adr/0016決定5: Cognitoのトリガー呼び出し自体が真実源)
/// ため、1関数にまとめている。`PutEventsRequestEntry`は一度`build()`すると個々のフィールドを
/// 後から追加できないビルダー型のため、`event_bus_name`もここで受け取って設定する
/// (`account_outbox_projector.rs`がエントリ組み立て時に`.event_bus_name(...)`を呼ぶのと同じ)。
pub fn build_entry(
    event_bus_name: &str,
    source: &str,
    detail_type: &str,
    envelope: &AuthEventEnvelope,
) -> Result<aws_sdk_eventbridge::types::PutEventsRequestEntry, serde_json::Error> {
    let detail = serde_json::to_string(envelope)?;
    Ok(aws_sdk_eventbridge::types::PutEventsRequestEntry::builder()
        .event_bus_name(event_bus_name)
        .source(source)
        .detail_type(detail_type)
        .detail(detail)
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(data: serde_json::Value) -> AuthEventEnvelope {
        AuthEventEnvelope {
            event_id: uuid::Uuid::new_v4(),
            user_id: "user-123".to_string(),
            occurred_at: "2026-08-13T00:00:00Z".to_string(),
            data,
        }
    }

    #[test]
    fn built_entry_carries_the_given_bus_source_and_detail_type() {
        let envelope = envelope(json!({"username": "taro"}));
        let entry = build_entry("domain-event-bus", "auth-service", "auth.event.SignedUp", &envelope).unwrap();
        assert_eq!(entry.event_bus_name(), Some("domain-event-bus"));
        assert_eq!(entry.source(), Some("auth-service"));
        assert_eq!(entry.detail_type(), Some("auth.event.SignedUp"));
    }

    #[test]
    fn built_entry_detail_round_trips_to_the_original_envelope_shape() {
        let envelope = envelope(json!({"username": "taro"}));
        let entry = build_entry("domain-event-bus", "auth-service", "auth.event.SignedUp", &envelope).unwrap();
        let detail: serde_json::Value = serde_json::from_str(entry.detail().unwrap()).unwrap();
        assert_eq!(detail["user_id"], json!("user-123"));
        assert_eq!(detail["occurred_at"], json!("2026-08-13T00:00:00Z"));
        assert_eq!(detail["data"], json!({"username": "taro"}));
    }

    #[test]
    fn built_entry_detail_contains_the_event_id() {
        let envelope = envelope(json!("SignedIn"));
        let entry = build_entry("domain-event-bus", "auth-service", "auth.event.SignedIn", &envelope).unwrap();
        let detail: serde_json::Value = serde_json::from_str(entry.detail().unwrap()).unwrap();
        assert_eq!(detail["event_id"], json!(envelope.event_id));
    }
}

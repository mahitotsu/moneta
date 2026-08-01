use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

/// account-serviceがEventBridgeへ発行するイベントの`detail`の形。発行側(account-outbox-relay)と
/// 購読側(query-serviceのaccount-query-projector)の双方がこの型を通してやり取りする——これが
/// account-serviceの公開契約(ドメインイベントスキーマ)そのもの(docs/adr/0004)。account-domainに
/// 置く理由: query-serviceがaccount-service crate全体(DSQL/SQS等の書き込み経路専用の依存関係)に
/// 依存せずにこの契約だけを共有するため(docs/adr/0008)。AWS/DB依存を持たないゼロ依存の契約型
/// という点で、`Event`/`Command`と同じ立ち位置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub event_id: Uuid,
    pub account_id: Uuid,
    pub occurred_at: OffsetDateTime,
    /// "event"(状態変化を表すもの) または "rejection"(却下されたコマンド)。
    pub kind: String,
    /// account-domainの`Event`または`DomainError`のJSON表現(serdeのデフォルト外部タグ形式)。
    pub data: Value,
}

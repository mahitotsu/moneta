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
    /// コマンド発行元(例: transfer-service)が付与する不透明な相関ID(docs/adr/0010決定4)。
    /// account-domainの状態遷移ロジック(`apply`/`evolve`)はこの値を一切参照しない——
    /// このイベントを誰が引き起こしたコマンドの結果かを購読側が追跡するための、輸送のみの
    /// 関心事。発行しないコマンド(顧客の通常操作)では常に`None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    /// Deposit/Withdrawを起こした外部チャネル(`"Atm"`/`"IncomingTransfer"`/`"BillPayment"`、
    /// docs/adr/0023)。`correlation_id`と同じ「輸送のみの関心事」——account-domainの状態遷移
    /// ロジックはこの値を一切参照せず、`Command`/`Event`の一部にもしない。外部チャネル・
    /// エミュレータ(docs/adr/0009決定1)が呼ぶDeposit/Withdrawにだけ付与され、値の正しさは
    /// API Gatewayのリクエストモデル(enum制約)が担保する——account-domainは型で強制せず、
    /// 素通しの`Option<String>`のまま扱う。顧客の通常操作やtransfer-service経由の入出金
    /// (`correlation_id`が設定される方)では常に`None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
}

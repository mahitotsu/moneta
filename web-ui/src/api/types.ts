// バックエンドのワイヤーフォーマットに対応する型。
// - 金額/残高は数値ではなく文字列(rust_decimalのserde-with-str機能、docs/adr/0006決定5)。
// - FreezeReasonの値は、リクエスト側(コマンド)とレスポンス側(view)で表記が異なる:
//   リクエストはRustのenumバリアント名そのまま(PascalCase、docs/adr/0006決定5)、
//   viewはaccount-service/src/projection.rsのfreeze_reason_labelが生成するsnake_caseラベル。
//   両者を取り違えないよう別の型として定義する。

/** `POST .../freeze`のリクエストボディで使う値。Rustのenumバリアント名と厳密一致。 */
export type FreezeReasonRequest = "SuspectedFraud" | "CourtOrder" | "CustomerRequest";

/** `GET /accounts/{id}`のレスポンスの`frozenReason`で返る値。 */
export type FreezeReasonView = "suspected_fraud" | "court_order" | "customer_request";

export const FREEZE_REASONS: { value: FreezeReasonRequest; label: string }[] = [
  { value: "SuspectedFraud", label: "不正利用の疑い (SuspectedFraud)" },
  { value: "CourtOrder", label: "裁判所命令 (CourtOrder)" },
  { value: "CustomerRequest", label: "本人からの依頼 (CustomerRequest)" },
];

/** `frozenReason`/取引履歴の`reason`(共にFreezeReasonView)を表示する際の日本語ラベル。 */
export const FREEZE_REASON_VIEW_LABEL: Record<FreezeReasonView, string> = {
  suspected_fraud: "不正利用の疑い",
  court_order: "裁判所命令",
  customer_request: "本人からの依頼",
};

/** `GET /accounts/{id}`のレスポンス全体(projection.rsのstate_to_viewが単一の真実源)。 */
export type AccountView =
  | { status: "active"; balance: string; frozenReason: null; frozenAt: null; closedAt: null }
  | { status: "frozen"; balance: string; frozenReason: FreezeReasonView; frozenAt: string; closedAt: null }
  | { status: "closed"; balance: string; frozenReason: null; frozenAt: null; closedAt: string };

/** 書き込み系エンドポイントは全て`202 Accepted`(ADR-0006決定6、結果整合性)。 */
export interface CommandAcceptedResponse {
  accountId: string;
  status: "accepted";
}

/**
 * `GET /accounts/{id}/transactions`のレスポンス配列の要素
 * (query-service/src/history.rsのhistory_entry_from_eventが単一の真実源、docs/adr/0009)。
 * amountはopened/frozen/unfrozen/closedでは無い(null)——それらは金額の増減を伴わない。
 */
export interface TransactionEntry {
  type: "opened" | "deposited" | "withdrawn" | "frozen" | "unfrozen" | "closed";
  amount: string | null;
  balanceAfter: string;
  occurredAt: string;
  eventId: string;
  reason: FreezeReasonView | null;
}

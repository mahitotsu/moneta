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
 * `GET /customers/me/accounts`のレスポンス配列の要素(docs/adr/0016決定4)。ownerIdは
 * リクエストに含めない——Cognito JWTのsubクレームから常にサーバー側で決まるため、
 * レスポンス自体にも含まれない(呼び出し側は「自分」の一覧だと分かっている)。
 */
export interface MyAccount {
  accountId: string;
  openedAt: string;
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

/**
 * 振替(同一名義間)/振込(名義不一致)/組戻し(docs/adr/0011)。サーバー側の名義突き合わせ
 * (`transfer-service`のowner index projection)が決めるものであり、クライアントは`Start`/
 * `Recall`のリクエストにこの値を含めない——`GET /transfers/{transferId}`・
 * `GET /customers/me/transfers`(`TransferStatusView`、docs/adr/0017)のレスポンスとして
 * のみ受け取る(docs/adr/0012決定1)。
 */
export type TransferKind = "furikae" | "furikomi" | "recall";

/** `crates/transfer-service/src/saga.rs`の`SagaState`と1対1(snake_case化のみ)。 */
export type TransferState =
  | "pending_confirmation"
  | "pending_debit"
  | "pending_credit"
  | "compensating"
  | "credited"
  | "compensated"
  | "failed"
  | "cancelled";

/** `GET /transfers/{transferId}`のレスポンス全体
 * (`transfer-status-projector`のフィールド写像が単一の真実源、docs/adr/0012決定1)。
 * `GET /customers/me/transfers`(docs/adr/0017)の配列要素も同じ形——
 * `transfer-history-projector`が同じソース(`TransferSagaTable`)から同じフィールドを
 * 写像するため。 */
export interface TransferStatusView {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  kind: TransferKind;
  state: TransferState;
  updatedAt: string;
}

/**
 * `GET /account-numbers/{accountNumber}`と`GET /accounts/{accountId}/account-number`の
 * レスポンス(どちらも同じ形、docs/adr/0015)。accountIdはUUIDのまま変わらず、これは人間可読な
 * 別名(支店+7桁の口座番号)への・からの読み取り専用マッピングにすぎない。
 */
export interface AccountNumberLookup {
  accountId: string;
  ownerId: string;
  accountNumber: string;
  branchCode: string;
  branchName: string;
}

export const TRANSFER_KIND_LABEL: Record<TransferKind, string> = {
  furikae: "振替",
  furikomi: "振込",
  recall: "組戻し",
};

/** AWS/HTTP等の内部用語を出さない業務言語のみの文言(過去の指摘事項、web-ui全体の方針)。 */
export const TRANSFER_STATE_LABEL: Record<TransferState, string> = {
  pending_confirmation: "確認待ち",
  pending_debit: "手続き中",
  pending_credit: "手続き中",
  compensating: "取消処理中",
  credited: "完了",
  compensated: "取消完了",
  failed: "手続きできませんでした",
  cancelled: "取消済み",
};

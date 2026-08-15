// バックエンドはrust_decimalの文字列表現をそのまま返す(docs/adr/0006決定5)。
// JS Numberへ変換すると大きな金額でIEEE754精度が壊れうるため、桁区切りは文字列操作のみで行う。

/** 残高マスク時(useBalanceHidden)に表示する固定文字列。一覧・詳細で共通にする。 */
export const MASKED_BALANCE = "¥ ••••••••";

export function formatCurrency(raw: string): string {
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [intPart, fracPart] = unsigned.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const amount = fracPart ? `${grouped}.${fracPart}` : grouped;
  return `${negative ? "-" : ""}¥${amount}`;
}

/** UUIDの口座IDを実在の口座番号風に短縮表示する(表示専用の飾り、実データは常にUUID全体)。 */
export function formatAccountNumber(accountId: string): string {
  const hex = accountId.replace(/-/g, "");
  const last8 = hex.slice(-8);
  return `${last8.slice(0, 4)}-${last8.slice(4)}`.toUpperCase();
}

/** 発番される口座番号(7桁の数字、docs/adr/0015決定3)。振込先の口座番号入力欄の簡易
 * バリデーションに使う。 */
export const ACCOUNT_NUMBER_PATTERN = /^\d{7}$/;

/** 入力欄から数字以外(スペース・ハイフン等)を取り除く。口座番号は貼り付けやコピー時に
 * 区切り記号が混ざることを想定し、送信/検証の前に正規化する。 */
export function normalizeAccountNumberInput(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** 発番された口座番号(7桁)を人間が読みやすいよう区切って表示する(例: "1234567" →
 * "123-4567")。実データは常に区切りなしの7桁文字列。 */
export function formatFriendlyAccountNumber(accountNumber: string): string {
  return `${accountNumber.slice(0, 3)}-${accountNumber.slice(3)}`;
}

function toDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateLabel(iso: string): string {
  const d = toDate(iso);
  return d ? d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" }) : iso;
}

export function formatTimeLabel(iso: string): string {
  const d = toDate(iso);
  return d ? d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "";
}

export function formatDateTime(iso: string): string {
  const time = formatTimeLabel(iso);
  return time ? `${formatDateLabel(iso)} ${time}` : formatDateLabel(iso);
}

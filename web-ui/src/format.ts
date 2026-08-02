// バックエンドはrust_decimalの文字列表現をそのまま返す(docs/adr/0006決定5)。
// JS Numberへ変換すると大きな金額でIEEE754精度が壊れうるため、桁区切りは文字列操作のみで行う。

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

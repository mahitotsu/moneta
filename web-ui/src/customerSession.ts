// ダミーサインイン + 顧客ごとの口座リストを、localStorageだけで表現する(docs/adr/0009)。
// バックエンドに「顧客」という概念は一切追加しない——このデモに閉じた割り切りであり、
// 複数ブラウザ・複数端末間では共有されない。将来Transfer serviceを実装する際、本物の
// 顧客-口座関係が必要になれば見直す。

const SIGNED_IN_KEY = "moneta.signedInCustomer";
const accountsKey = (customerName: string) => `moneta.accounts.${customerName}`;

export interface CustomerAccount {
  accountId: string;
  nickname?: string;
}

export function getSignedInCustomer(): string | null {
  return localStorage.getItem(SIGNED_IN_KEY);
}

export function signIn(name: string): void {
  localStorage.setItem(SIGNED_IN_KEY, name);
}

export function signOut(): void {
  localStorage.removeItem(SIGNED_IN_KEY);
}

export function getAccountsFor(customerName: string): CustomerAccount[] {
  const raw = localStorage.getItem(accountsKey(customerName));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CustomerAccount[];
  } catch {
    return [];
  }
}

export function addAccountFor(customerName: string, accountId: string, nickname?: string): void {
  const existing = getAccountsFor(customerName);
  if (existing.some((a) => a.accountId === accountId)) return;
  const updated = [...existing, { accountId, nickname }];
  localStorage.setItem(accountsKey(customerName), JSON.stringify(updated));
}

/** バックエンドに存在しない口座(確定404)をこの一覧から外す。口座自体は削除しない。 */
export function removeAccountFor(customerName: string, accountId: string): void {
  const updated = getAccountsFor(customerName).filter((a) => a.accountId !== accountId);
  localStorage.setItem(accountsKey(customerName), JSON.stringify(updated));
}

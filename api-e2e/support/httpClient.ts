// Wire-format types mirror web-ui/src/api/types.ts exactly (same backend contract). Kept as
// a separate copy rather than a shared import: web-ui and infra are independent TS projects,
// and this harness deliberately talks to the raw API Gateway URLs (docs/adr/0006/0004)
// instead of the CloudFront-proxied relative paths web-ui uses (docs/adr/0007).
import { subFromIdToken } from "./auth";
import { trackCreatedAccount } from "./testDataCleanup";

export type FreezeReasonRequest = "SuspectedFraud" | "CourtOrder" | "CustomerRequest";
export type FreezeReasonView = "suspected_fraud" | "court_order" | "customer_request";

export type AccountView =
  | { status: "active"; balance: string; frozenReason: null; frozenAt: null; closedAt: null }
  | { status: "frozen"; balance: string; frozenReason: FreezeReasonView; frozenAt: string; closedAt: null }
  | { status: "closed"; balance: string; frozenReason: null; frozenAt: null; closedAt: string };

export interface TransactionEntry {
  type: "opened" | "deposited" | "withdrawn" | "frozen" | "unfrozen" | "closed";
  amount: string | null;
  balanceAfter: string;
  occurredAt: string;
  eventId: string;
  reason: FreezeReasonView | null;
}

// `GET /customers/me/accounts`のレスポンス配列の要素(docs/adr/0016決定4)。ownerIdはCognito
// JWTのsubクレームから常にサーバー側で決まるため、レスポンス自体には含まれない
// (web-ui/src/api/types.tsのMyAccountと同じ形)。
export interface MyAccountEntry {
  accountId: string;
  openedAt: string;
}

// `GET /customers/me/points/history`のレスポンス配列の要素(docs/adr/0026)。
// web-ui/src/api/types.tsのPointsHistoryEntryと同じ形。
export interface PointsHistoryEntry {
  type: "reserved" | "awarded" | "refunded";
  amount: string;
  balanceAfter: string;
  occurredAt: string;
  eventId: string;
  transferId: string;
}

export interface RawResponse<T = unknown> {
  status: number;
  body: T;
}

// Unlike web-ui/src/api/client.ts (which deliberately hides status codes/internals from the
// customer, docs/adr/0009), scenarios here need the raw status code: it *is* part of the
// documented external contract (202 accepted, 4xx validation, 404 not-found).
export async function rawRequest<T = unknown>(url: string, init: RequestInit = {}): Promise<RawResponse<T>> {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = (text.length > 0 ? JSON.parse(text) : undefined) as T;
  return { status: response.status, body };
}

// 顧客向けエンドポイント(docs/adr/0016決定2)向けのAuthorizationヘッダー。`idToken`未指定なら
// 何も付けない——意図的に未認証のリクエストを送りたい呼び出し側(認可エンドポイントの401検証、
// Deposit/Withdrawのような元々認証不要なエンドポイント)のために、必須ではなくオプショナルに
// している。web-ui/src/api/client.tsのauthHeaders()と同じ形。
export function authHeaders(idToken?: string): Record<string, string> {
  return idToken !== undefined ? { Authorization: `Bearer ${idToken}` } : {};
}

// docs/adr/0026: 新しい順に最大50件(ページネーション省略、`AccountHistoryTable`の
// `GET .../transactions`と同じPoCスコープの割り切り)。
export async function getMyPointsHistory(pointsQueryApiUrl: string, idToken: string): Promise<RawResponse<PointsHistoryEntry[]>> {
  return rawRequest<PointsHistoryEntry[]>(`${pointsQueryApiUrl}/customers/me/points/history`, { headers: authHeaders(idToken) });
}

function jsonHeaders(idToken?: string, idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeaders(idToken) };
  if (idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return headers;
}

// docs/adr/0023: Deposit/Withdrawの外部チャネル(web-ui/src/api/types.tsのChannelと同じ形、
// このファイル冒頭のコメント通りコード共有はせず型だけ揃える)。DepositCommandModel/
// WithdrawalCommandModelはどちらも"Atm"を許容するため、テストヘルパーの既定値として使う
// (呼び出し側が入金/出金それぞれ固有のチャネル("IncomingTransfer"/"BillPayment")を
// 明示的に検証したい場合は引数で上書きできる)。
export type DepositChannel = "Atm" | "IncomingTransfer";
export type WithdrawalChannel = "Atm" | "BillPayment";

export interface CommandApi {
  openAccount(accountId: string, initialBalance: string, idempotencyKey?: string): Promise<RawResponse>;
  deposit(accountId: string, amount: string, idempotencyKey?: string, channel?: DepositChannel): Promise<RawResponse>;
  withdraw(accountId: string, amount: string, idempotencyKey?: string, channel?: WithdrawalChannel): Promise<RawResponse>;
  freeze(accountId: string, reason: FreezeReasonRequest, idempotencyKey?: string): Promise<RawResponse>;
  unfreeze(accountId: string, idempotencyKey?: string): Promise<RawResponse>;
  close(accountId: string, idempotencyKey?: string): Promise<RawResponse>;
}

// `idempotencyKey` defaults to a fresh UUID per call (matching web-ui's behavior of one key
// per distinct customer action, docs/adr/0006決定3) but can be pinned by scenarios that need
// to force a specific dedup/omission case (E1 in docs/e2e-scenarios.md, 旧C1/C2).
//
// `idToken`(docs/adr/0016決定2)は省略可能——Deposit/Withdrawは外部チャネルとして引き続き
// 認証不要(ADR-0009決定1)なままなので付けなくても動くが、付けても害はない(それらの
// リソースにはそもそもCognito Authorizerが付いていない)。Open/Freeze/Unfreeze/Closeは省略すると
// 401になる。openAccount()はもはやowner_idをリクエストボディに含めない——OpenCommandModelが
// `additionalProperties: false`かつowner_idをプロパティとして持たなくなった(VTLが
// `$context.authorizer.claims.sub`を直接使う、docs/adr/0016決定3)ため、ボディに含めると
// むしろAPIGWのリクエスト検証で拒否される。
export function createCommandApi(baseUrl: string, idToken?: string): CommandApi {
  return {
    openAccount: async (accountId, initialBalance, idempotencyKey = crypto.randomUUID()) => {
      const response = await rawRequest(`${baseUrl}/accounts/${accountId}`, {
        method: "PUT",
        headers: jsonHeaders(idToken, idempotencyKey),
        body: JSON.stringify({ initial_balance: initialBalance }),
      });
      // support/testDataCleanup.tsのteardownに乗せる(2026-08-14発覚: 口座データもCognito
      // ユーザーと同じく際限なく積み上がっていた)。ownerIdはこのcommandApiを構築した
      // idTokenのsubそのもの(docs/adr/0016決定3、Openはリクエストボディのowner_idを
      // 見ない)——ここでも同じ値をidTokenから取り出すだけで、サーバーとの二重管理にはならない。
      if (response.status === 202 && idToken) {
        const ownerId = subFromIdToken(idToken);
        if (ownerId) trackCreatedAccount(accountId, ownerId);
      }
      return response;
    },
    deposit: (accountId, amount, idempotencyKey = crypto.randomUUID(), channel: DepositChannel = "Atm") =>
      rawRequest(`${baseUrl}/accounts/${accountId}/deposits`, {
        method: "POST",
        headers: jsonHeaders(idToken, idempotencyKey),
        body: JSON.stringify({ amount, channel }),
      }),
    withdraw: (accountId, amount, idempotencyKey = crypto.randomUUID(), channel: WithdrawalChannel = "Atm") =>
      rawRequest(`${baseUrl}/accounts/${accountId}/withdrawals`, {
        method: "POST",
        headers: jsonHeaders(idToken, idempotencyKey),
        body: JSON.stringify({ amount, channel }),
      }),
    freeze: (accountId, reason, idempotencyKey = crypto.randomUUID()) =>
      rawRequest(`${baseUrl}/accounts/${accountId}/freeze`, {
        method: "POST",
        headers: jsonHeaders(idToken, idempotencyKey),
        body: JSON.stringify({ reason }),
      }),
    unfreeze: (accountId, idempotencyKey = crypto.randomUUID()) =>
      rawRequest(`${baseUrl}/accounts/${accountId}/unfreeze`, {
        method: "POST",
        headers: jsonHeaders(idToken, idempotencyKey),
      }),
    close: (accountId, idempotencyKey = crypto.randomUUID()) =>
      rawRequest(`${baseUrl}/accounts/${accountId}/close`, {
        method: "POST",
        headers: jsonHeaders(idToken, idempotencyKey),
      }),
  };
}

export interface QueryApi {
  getAccount(accountId: string): Promise<AccountView | null>;
  getTransactionHistory(accountId: string): Promise<TransactionEntry[]>;
  getMyAccounts(): Promise<MyAccountEntry[]>;
}

// `idToken`省略時は無認証でリクエストする(docs/adr/0016決定2の401挙動をscenarios/auth.e2e.test.ts
// が直接検証するために使う)。
export function createQueryApi(baseUrl: string, idToken?: string): QueryApi {
  return {
    getAccount: async (accountId) => {
      const response = await rawRequest<AccountView>(`${baseUrl}/accounts/${accountId}`, { headers: authHeaders(idToken) });
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new Error(`getAccount(${accountId}) unexpected status ${response.status}: ${JSON.stringify(response.body)}`);
      }
      return response.body;
    },
    getTransactionHistory: async (accountId) => {
      const response = await rawRequest<TransactionEntry[]>(`${baseUrl}/accounts/${accountId}/transactions`, {
        headers: authHeaders(idToken),
      });
      if (response.status !== 200) {
        throw new Error(`getTransactionHistory(${accountId}) unexpected status ${response.status}: ${JSON.stringify(response.body)}`);
      }
      return response.body;
    },
    getMyAccounts: async () => {
      const response = await rawRequest<MyAccountEntry[]>(`${baseUrl}/customers/me/accounts`, {
        headers: authHeaders(idToken),
      });
      if (response.status !== 200) {
        throw new Error(`getMyAccounts() unexpected status ${response.status}: ${JSON.stringify(response.body)}`);
      }
      return response.body;
    },
  };
}

// Wire-format types mirror web-ui/src/api/types.ts exactly (same backend contract). Kept as
// a separate copy rather than a shared import: web-ui and infra are independent TS projects,
// and this harness deliberately talks to the raw API Gateway URLs (docs/adr/0006/0004)
// instead of the CloudFront-proxied relative paths web-ui uses (docs/adr/0007).
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

function jsonHeaders(idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return headers;
}

export interface CommandApi {
  // ownerId: docs/adr/0011。省略時は固定のダミー顧客名を使う(このハーネスはowner_idの
  // 中身自体を検証対象にしていないシナリオが大半のため、既存の呼び出し箇所を壊さない)。
  openAccount(accountId: string, initialBalance: string, ownerId?: string, idempotencyKey?: string): Promise<RawResponse>;
  deposit(accountId: string, amount: string, idempotencyKey?: string): Promise<RawResponse>;
  withdraw(accountId: string, amount: string, idempotencyKey?: string): Promise<RawResponse>;
  freeze(accountId: string, reason: FreezeReasonRequest, idempotencyKey?: string): Promise<RawResponse>;
  unfreeze(accountId: string, idempotencyKey?: string): Promise<RawResponse>;
  close(accountId: string, idempotencyKey?: string): Promise<RawResponse>;
}

// `idempotencyKey` defaults to a fresh UUID per call (matching web-ui's behavior of one key
// per distinct customer action, docs/adr/0006決定3) but can be pinned by scenarios that need
// to force a specific dedup/omission case (E1 in docs/e2e-scenarios.md, 旧C1/C2).
export function createCommandApi(baseUrl: string): CommandApi {
  return {
    openAccount: (accountId, initialBalance, ownerId = "e2e-test-customer", idempotencyKey = crypto.randomUUID()) =>
      rawRequest(`${baseUrl}/accounts/${accountId}`, {
        method: "PUT",
        headers: jsonHeaders(idempotencyKey),
        body: JSON.stringify({ owner_id: ownerId, initial_balance: initialBalance }),
      }),
    deposit: (accountId, amount, idempotencyKey = crypto.randomUUID()) =>
      rawRequest(`${baseUrl}/accounts/${accountId}/deposits`, {
        method: "POST",
        headers: jsonHeaders(idempotencyKey),
        body: JSON.stringify({ amount }),
      }),
    withdraw: (accountId, amount, idempotencyKey = crypto.randomUUID()) =>
      rawRequest(`${baseUrl}/accounts/${accountId}/withdrawals`, {
        method: "POST",
        headers: jsonHeaders(idempotencyKey),
        body: JSON.stringify({ amount }),
      }),
    freeze: (accountId, reason, idempotencyKey = crypto.randomUUID()) =>
      rawRequest(`${baseUrl}/accounts/${accountId}/freeze`, {
        method: "POST",
        headers: jsonHeaders(idempotencyKey),
        body: JSON.stringify({ reason }),
      }),
    unfreeze: (accountId, idempotencyKey = crypto.randomUUID()) =>
      rawRequest(`${baseUrl}/accounts/${accountId}/unfreeze`, {
        method: "POST",
        headers: jsonHeaders(idempotencyKey),
      }),
    close: (accountId, idempotencyKey = crypto.randomUUID()) =>
      rawRequest(`${baseUrl}/accounts/${accountId}/close`, {
        method: "POST",
        headers: jsonHeaders(idempotencyKey),
      }),
  };
}

export interface QueryApi {
  getAccount(accountId: string): Promise<AccountView | null>;
  getTransactionHistory(accountId: string): Promise<TransactionEntry[]>;
}

export function createQueryApi(baseUrl: string): QueryApi {
  return {
    getAccount: async (accountId) => {
      const response = await rawRequest<AccountView>(`${baseUrl}/accounts/${accountId}`);
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new Error(`getAccount(${accountId}) unexpected status ${response.status}: ${JSON.stringify(response.body)}`);
      }
      return response.body;
    },
    getTransactionHistory: async (accountId) => {
      const response = await rawRequest<TransactionEntry[]>(`${baseUrl}/accounts/${accountId}/transactions`);
      if (response.status !== 200) {
        throw new Error(`getTransactionHistory(${accountId}) unexpected status ${response.status}: ${JSON.stringify(response.body)}`);
      }
      return response.body;
    },
  };
}

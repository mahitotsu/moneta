import type { AccountView, CommandAcceptedResponse, FreezeReasonRequest } from "./types";

// 相対パスのみを叩く。本番はCloudFrontのbehavior(/query-api/*, /command-api/*)、
// ローカル開発はvite.config.tsのserver.proxyが、それぞれ実際のAPI Gatewayへ転送する
// (docs/adr/0007) ため、このファイルに環境ごとのURL分岐は持たない。
const QUERY_API_BASE = "/query-api";
const COMMAND_API_BASE = "/command-api";

async function postCommand(path: string, body?: unknown): Promise<CommandAcceptedResponse> {
  const response = await fetch(`${COMMAND_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // 全コマンドで必須(ADR-0006決定3)。SQSのMessageDeduplicationIdにそのままマップされる。
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`command failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<CommandAcceptedResponse>;
}

/** 口座IDはクライアント側で生成し、PUTで開設する(ADR-0006決定2)。 */
export async function openAccount(initialBalance: string): Promise<CommandAcceptedResponse> {
  const accountId = crypto.randomUUID();
  const response = await fetch(`${COMMAND_API_BASE}/accounts/${accountId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ initial_balance: initialBalance }),
  });
  if (!response.ok) {
    throw new Error(`open failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<CommandAcceptedResponse>;
}

export function deposit(accountId: string, amount: string): Promise<CommandAcceptedResponse> {
  return postCommand(`/accounts/${accountId}/deposits`, { amount });
}

export function withdraw(accountId: string, amount: string): Promise<CommandAcceptedResponse> {
  return postCommand(`/accounts/${accountId}/withdrawals`, { amount });
}

export function freeze(accountId: string, reason: FreezeReasonRequest): Promise<CommandAcceptedResponse> {
  return postCommand(`/accounts/${accountId}/freeze`, { reason });
}

export function unfreeze(accountId: string): Promise<CommandAcceptedResponse> {
  return postCommand(`/accounts/${accountId}/unfreeze`);
}

export function closeAccount(accountId: string): Promise<CommandAcceptedResponse> {
  return postCommand(`/accounts/${accountId}/close`);
}

/** 見つからない場合は`null`を返す(404)。それ以外の非2xxは例外を投げる。 */
export async function getAccount(accountId: string): Promise<AccountView | null> {
  const response = await fetch(`${QUERY_API_BASE}/accounts/${accountId}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`query failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<AccountView>;
}

import type { AccountView, CommandAcceptedResponse, FreezeReasonRequest, TransactionEntry } from "./types";

// 相対パスのみを叩く。本番はCloudFrontのbehavior(/query-api/*, /command-api/*)、
// ローカル開発はvite.config.tsのserver.proxyが、それぞれ実際のAPI Gatewayへ転送する
// (docs/adr/0007) ため、このファイルに環境ごとのURL分岐は持たない。
const QUERY_API_BASE = "/query-api";
const COMMAND_API_BASE = "/command-api";

// 画面にはHTTPステータスやレスポンス本文といった内部実装を一切出さず、業務的な文言だけを
// 見せる。生の失敗内容は開発者向けにconsole.errorへ残す(このPoCにサーバーサイドの
// エラー収集基盤は無いため)。DomainErrorによる却下(残高不足・凍結中等)は現状まだ顧客へ
// 通知する経路が無く(docs/adr/0002)、ここでcatchされるのは常にネットワーク障害や
// API Gateway/SQS側のインフラ障害である。
const COMMAND_FAILURE_MESSAGE = "手続きの受け付けに失敗しました。時間をおいて再度お試しください。";
const QUERY_FAILURE_MESSAGE = "情報の取得に失敗しました。時間をおいて再度お試しください。";

async function fetchOrThrow(input: string, init: RequestInit, businessMessage: string, logLabel: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (cause) {
    console.error(`${logLabel}: network error`, cause);
    throw new Error(businessMessage);
  }
  if (!response.ok) {
    console.error(`${logLabel}: ${response.status} ${await response.text()}`);
    throw new Error(businessMessage);
  }
  return response;
}

async function postCommand(path: string, body?: unknown): Promise<CommandAcceptedResponse> {
  const response = await fetchOrThrow(
    `${COMMAND_API_BASE}${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 全コマンドで必須(ADR-0006決定3)。SQSのMessageDeduplicationIdにそのままマップされる。
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    COMMAND_FAILURE_MESSAGE,
    `postCommand ${path}`,
  );
  return response.json() as Promise<CommandAcceptedResponse>;
}

/** 口座IDはクライアント側で生成し、PUTで開設する(ADR-0006決定2)。 */
export async function openAccount(initialBalance: string): Promise<CommandAcceptedResponse> {
  const accountId = crypto.randomUUID();
  const response = await fetchOrThrow(
    `${COMMAND_API_BASE}/accounts/${accountId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ initial_balance: initialBalance }),
    },
    COMMAND_FAILURE_MESSAGE,
    "openAccount",
  );
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
  let response: Response;
  try {
    response = await fetch(`${QUERY_API_BASE}/accounts/${accountId}`);
  } catch (cause) {
    console.error("getAccount: network error", cause);
    throw new Error(QUERY_FAILURE_MESSAGE);
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    console.error(`getAccount: ${response.status} ${await response.text()}`);
    throw new Error(QUERY_FAILURE_MESSAGE);
  }
  return response.json() as Promise<AccountView>;
}

/** 新しい順に最大50件(ページネーションは省略、docs/adr/0009)。 */
export async function getTransactionHistory(accountId: string): Promise<TransactionEntry[]> {
  const response = await fetchOrThrow(
    `${QUERY_API_BASE}/accounts/${accountId}/transactions`,
    {},
    QUERY_FAILURE_MESSAGE,
    "getTransactionHistory",
  );
  return response.json() as Promise<TransactionEntry[]>;
}

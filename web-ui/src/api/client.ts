import type { AccountView, CommandAcceptedResponse, FreezeReasonRequest, TransactionEntry, TransferStatusView } from "./types";

// 相対パスのみを叩く。本番はCloudFrontのbehavior(/query-api/*, /command-api/*)、
// ローカル開発はvite.config.tsのserver.proxyが、それぞれ実際のAPI Gatewayへ転送する
// (docs/adr/0007) ため、このファイルに環境ごとのURL分岐は持たない。
const QUERY_API_BASE = "/query-api";
const COMMAND_API_BASE = "/command-api";
// Transfer serviceの顧客向けAPI(docs/adr/0012決定5)。account-serviceのものとは別プレフィックス。
const TRANSFER_QUERY_API_BASE = "/transfer-query-api";
const TRANSFER_COMMAND_API_BASE = "/transfer-command-api";

// 画面にはHTTPステータスやレスポンス本文といった内部実装を一切出さず、業務的な文言だけを
// 見せる。生の失敗内容は開発者向けにconsole.errorへ残す(このPoCにサーバーサイドの
// エラー収集基盤は無いため)。DomainErrorによる却下(残高不足・凍結中等)は現状まだ顧客へ
// 通知する経路が無く(docs/adr/0002)、ここでcatchされるのは常にネットワーク障害や
// API Gateway/SQS側のインフラ障害である。
const COMMAND_FAILURE_MESSAGE = "手続きの受け付けに失敗しました。時間をおいて再度お試しください。";
const QUERY_FAILURE_MESSAGE = "情報の取得に失敗しました。時間をおいて再度お試しください。";

// ネットワーク断・5xxのみ再試行する(4xxはリトライしても結果が変わらない)。
// `init.headers`にIdempotency-Keyが含まれる呼び出し(postCommand/openAccount)では、
// 呼び出し側が生成した同一のキーを全試行で使い回すことで、SQSのMessageDeduplicationId
// による重複排除(ADR-0006決定3)が効き、途中で失敗して自動再試行しても
// バックエンド側で二重にコマンドが処理されることはない。
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOrThrow(input: string, init: RequestInit, businessMessage: string, logLabel: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (cause) {
      if (attempt < MAX_RETRIES) {
        console.warn(`${logLabel}: network error, retrying (${attempt + 1}/${MAX_RETRIES})`, cause);
        await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      console.error(`${logLabel}: network error`, cause);
      throw new Error(businessMessage);
    }
    if (!response.ok) {
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        console.warn(`${logLabel}: ${response.status}, retrying (${attempt + 1}/${MAX_RETRIES})`);
        await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      console.error(`${logLabel}: ${response.status} ${await response.text()}`);
      throw new Error(businessMessage);
    }
    return response;
  }
}

async function postCommand(path: string, body?: unknown): Promise<CommandAcceptedResponse> {
  const response = await fetchOrThrow(
    `${COMMAND_API_BASE}${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 全コマンドで必須(ADR-0006決定3)。SQSのMessageDeduplicationIdにそのままマップされる。
        // fetchOrThrow内でのリトライはこの同一ヘッダーを使い回す。
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    COMMAND_FAILURE_MESSAGE,
    `postCommand ${path}`,
  );
  return response.json() as Promise<CommandAcceptedResponse>;
}

/**
 * 口座IDはクライアント側で生成し、PUTで開設する(ADR-0006決定2)。
 * ownerIdはサインイン済み顧客名(customerSession.tsのgetSignedInCustomer)をそのまま渡す——
 * 振替(同一名義間)/振込(名義不一致)をサーバ側で判定するための実データ(docs/adr/0011)。
 * ダミーサインインの値をそのまま使うだけで、新しい入力項目や認証機構を追加するものではない。
 */
export async function openAccount(ownerId: string, initialBalance: string): Promise<CommandAcceptedResponse> {
  const accountId = crypto.randomUUID();
  const response = await fetchOrThrow(
    `${COMMAND_API_BASE}/accounts/${accountId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ owner_id: ownerId, initial_balance: initialBalance }),
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

/**
 * Transfer serviceの送金受付API(docs/adr/0012決定2〜4)。account-serviceのpostCommandと異なり
 * `Idempotency-Key`ヘッダーは送らない——`transferId`とアクション名の組がVTL側で導出する
 * 冪等性キーになるため要求されない(決定3)。レスポンスはaccount-service同様、常に
 * `202 Accepted`(結果整合性、ADR-0002)であり、残高不足等のドメイン却下はこの時点では
 * わからない。取消/組戻しがサーバー側で却下された場合、対象の`transferId`はサガ自体が
 * 作られず照会APIが404を返し続ける——「まだ反映されていない」と区別がつかない
 * (決定6のトレードオフ、[[eventual_consistency_not_a_failure]])。
 */
async function transferCommand(method: string, path: string, body?: unknown): Promise<CommandAcceptedResponse> {
  const response = await fetchOrThrow(
    `${TRANSFER_COMMAND_API_BASE}${path}`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    COMMAND_FAILURE_MESSAGE,
    `transferCommand ${method} ${path}`,
  );
  return response.json() as Promise<CommandAcceptedResponse>;
}

/** `transferId`はクライアント生成(決定4、account-serviceの口座開設と同じ理由)。 */
export function startTransfer(
  transferId: string,
  fromAccountId: string,
  toAccountId: string,
  amount: string,
): Promise<CommandAcceptedResponse> {
  return transferCommand("PUT", `/transfers/${transferId}`, {
    from_account_id: fromAccountId,
    to_account_id: toAccountId,
    amount,
  });
}

export function confirmTransfer(transferId: string): Promise<CommandAcceptedResponse> {
  return transferCommand("POST", `/transfers/${transferId}/confirm`);
}

export function cancelTransfer(transferId: string): Promise<CommandAcceptedResponse> {
  return transferCommand("POST", `/transfers/${transferId}/cancel`);
}

/**
 * 組戻し。`transferId`は組戻し自身の新しいサガID(クライアント生成)、取消対象は
 * `originalTransferId`として渡す(決定4)。送金元・送金先はサーバー側が元のサガから
 * 引いて入れ替えるため、ここでは渡さない。
 */
export function recallTransfer(transferId: string, originalTransferId: string): Promise<CommandAcceptedResponse> {
  return transferCommand("PUT", `/transfers/${transferId}/recall`, { original_transfer_id: originalTransferId });
}

/** 見つからない場合は`null`を返す(404、getAccountと同じ変換)。 */
export async function getTransferStatus(transferId: string): Promise<TransferStatusView | null> {
  let response: Response;
  try {
    response = await fetch(`${TRANSFER_QUERY_API_BASE}/transfers/${transferId}`);
  } catch (cause) {
    console.error("getTransferStatus: network error", cause);
    throw new Error(QUERY_FAILURE_MESSAGE);
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    console.error(`getTransferStatus: ${response.status} ${await response.text()}`);
    throw new Error(QUERY_FAILURE_MESSAGE);
  }
  return response.json() as Promise<TransferStatusView>;
}

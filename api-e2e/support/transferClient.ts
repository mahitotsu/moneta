import { authHeaders, rawRequest, RawResponse } from "./httpClient";
import { waitFor, WaitForOptions } from "./poll";
import { trackCreatedTransfer } from "./testDataCleanup";

// Transfer serviceの顧客向けAPI(docs/adr/0012)。account-serviceのhttpClient.tsと同じ役割
// (Command API + Query API のHTTPラッパー)をTransfer向けに提供する——docs/adr/0010決定6時点の
// SQS直接投入/DynamoDB直接ポーリングという裏口は、この増分で正式なAPIに置き換わった
// (docs/e2e-scenarios.md参照)。

export type TransferKind = "furikae" | "furikomi" | "recall";

export type SagaState =
  | "pending_confirmation"
  | "pending_debit"
  | "pending_credit"
  | "compensating"
  | "credited"
  | "compensated"
  | "failed"
  | "cancelled";

export interface TransferStatusView {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  kind: TransferKind;
  state: SagaState;
  updatedAt: string;
  /** 振込の現金負担分の手数料(docs/adr/0025)。`GET /transfers/{transferId}`にしか無く、
   *  `GET /customers/me/transfers`には無い(web-ui/src/api/types.tsのTransferStatusViewと
   *  同じ非対称)ため任意フィールド。 */
  cashFee?: string;
}

export interface StartTransferInput {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
}

export interface RecallTransferInput {
  transferId: string;
  originalTransferId: string;
}

export interface TransferCommandApi {
  start(input: StartTransferInput): Promise<RawResponse>;
  confirm(transferId: string): Promise<RawResponse>;
  cancel(transferId: string): Promise<RawResponse>;
  recall(input: RecallTransferInput): Promise<RawResponse>;
}

// docs/adr/0012決定3: Idempotency-Keyヘッダーは要求しない(transferIdとアクション名の組が
// VTL側で導出する冪等性キーになるため)。account-serviceのcreateCommandApiと異なり、呼び出し側
// がヘッダーを用意する必要はない。
//
// `idToken`(docs/adr/0016決定2、TransferCommandApiも認証必須)は省略可能——httpClient.tsの
// createCommandApiと同じ形。account-serviceのFreeze/Unfreeze/Closeと違い、Start/Confirm/
// Cancel/Recallは呼び出し元がどの口座の名義かを検証しない(決定2の対象エンドポイント一覧に
// 含まれるのは「認証必須」のみで、決定3の所有者検証はaccount-service側だけの話)ため、
// どの認証済みidTokenを使っても構わない。
export function createTransferCommandApi(baseUrl: string, idToken?: string): TransferCommandApi {
  return {
    start: async (input) => {
      const response = await rawRequest(`${baseUrl}/transfers/${input.transferId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders(idToken) },
        body: JSON.stringify({
          from_account_id: input.fromAccountId,
          to_account_id: input.toAccountId,
          amount: input.amount,
        }),
      });
      // support/testDataCleanup.tsのteardownに乗せる(recall(組戻し)も新しいtransferIdの
      // Startとして表現される、docs/adr/0011決定5なので特別扱いは不要)。
      if (response.status === 202) trackCreatedTransfer(input.transferId);
      return response;
    },
    confirm: (transferId) =>
      rawRequest(`${baseUrl}/transfers/${transferId}/confirm`, { method: "POST", headers: authHeaders(idToken) }),
    cancel: (transferId) =>
      rawRequest(`${baseUrl}/transfers/${transferId}/cancel`, { method: "POST", headers: authHeaders(idToken) }),
    recall: (input) =>
      rawRequest(`${baseUrl}/transfers/${input.transferId}/recall`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders(idToken) },
        body: JSON.stringify({ original_transfer_id: input.originalTransferId }),
      }),
  };
}

export interface TransferQueryApi {
  getTransferStatus(transferId: string): Promise<TransferStatusView | null>;
  getMyTransfers(): Promise<TransferStatusView[]>;
}

export function createTransferQueryApi(baseUrl: string, idToken?: string): TransferQueryApi {
  return {
    getTransferStatus: async (transferId) => {
      const response = await rawRequest<TransferStatusView>(`${baseUrl}/transfers/${transferId}`, {
        headers: authHeaders(idToken),
      });
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new Error(
          `getTransferStatus(${transferId}) unexpected status ${response.status}: ${JSON.stringify(response.body)}`,
        );
      }
      return response.body;
    },
    // 顧客ごとの送金履歴(docs/adr/0017)。新しい順(サーバー側でScanIndexForward: false済み)。
    getMyTransfers: async () => {
      const response = await rawRequest<TransferStatusView[]>(`${baseUrl}/customers/me/transfers`, {
        headers: authHeaders(idToken),
      });
      if (response.status !== 200) {
        throw new Error(`getMyTransfers() unexpected status ${response.status}: ${JSON.stringify(response.body)}`);
      }
      return response.body;
    },
  };
}

// `support/sagaState.ts`の旧`waitForSagaState`と同じ役割を、DynamoDB直接ポーリングではなく
// この新しい照会APIで果たす(docs/adr/0012決定1、裏口の解消)。
export async function waitForTransferState(
  queryApi: TransferQueryApi,
  transferId: string,
  expectedStates: SagaState[],
  options: WaitForOptions = {},
): Promise<TransferStatusView> {
  return waitFor(
    async () => {
      const status = await queryApi.getTransferStatus(transferId);
      return status && expectedStates.includes(status.state) ? status : undefined;
    },
    { description: `transfer ${transferId} to reach state in [${expectedStates.join(", ")}]`, ...options },
  );
}

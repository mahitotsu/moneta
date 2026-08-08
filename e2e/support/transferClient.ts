import { rawRequest, RawResponse } from "./httpClient";
import { waitFor, WaitForOptions } from "./poll";

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
export function createTransferCommandApi(baseUrl: string): TransferCommandApi {
  return {
    start: (input) =>
      rawRequest(`${baseUrl}/transfers/${input.transferId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_account_id: input.fromAccountId,
          to_account_id: input.toAccountId,
          amount: input.amount,
        }),
      }),
    confirm: (transferId) => rawRequest(`${baseUrl}/transfers/${transferId}/confirm`, { method: "POST" }),
    cancel: (transferId) => rawRequest(`${baseUrl}/transfers/${transferId}/cancel`, { method: "POST" }),
    recall: (input) =>
      rawRequest(`${baseUrl}/transfers/${input.transferId}/recall`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ original_transfer_id: input.originalTransferId }),
      }),
  };
}

export interface TransferQueryApi {
  getTransferStatus(transferId: string): Promise<TransferStatusView | null>;
}

export function createTransferQueryApi(baseUrl: string): TransferQueryApi {
  return {
    getTransferStatus: async (transferId) => {
      const response = await rawRequest<TransferStatusView>(`${baseUrl}/transfers/${transferId}`);
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new Error(
          `getTransferStatus(${transferId}) unexpected status ${response.status}: ${JSON.stringify(response.body)}`,
        );
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

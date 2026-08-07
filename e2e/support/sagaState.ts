import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { REGION } from "./stackOutputs";
import { waitFor, WaitForOptions } from "./poll";

export type SagaState =
  | "pending_confirmation"
  | "pending_debit"
  | "pending_credit"
  | "compensating"
  | "credited"
  | "compensated"
  | "failed"
  | "cancelled";

export type TransferKind = "furikae" | "furikomi" | "recall";

export interface SagaItem {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  kind: TransferKind;
  state: SagaState;
  updatedAt: string;
}

let cachedDoc: DynamoDBDocumentClient | undefined;
function doc(): DynamoDBDocumentClient {
  if (!cachedDoc) cachedDoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cachedDoc;
}

// `crates/transfer-service/src/persistence.rs`のDynamoDB項目の形と一致させる
// (transferId/fromAccountId/toAccountId/amount/kind/state/updatedAt)。
export async function getSaga(sagaTableName: string, transferId: string): Promise<SagaItem | null> {
  const result = await doc().send(new GetCommand({ TableName: sagaTableName, Key: { transferId } }));
  return (result.Item as SagaItem | undefined) ?? null;
}

// account-serviceのイベントがDynamoDB Streams駆動のoutbox(docs/adr/0004・0013)経由で
// EventBridgeへ発行されて初めてtransfer-saga-step/transfer-owner-projectorが動くため、
// サガ状態の収束もaccount残高の収束と同じ`waitFor`ポーリングで待てる
// (docs/adr/0004・0010・0011、e2e/README.md)。
export async function waitForSagaState(
  sagaTableName: string,
  transferId: string,
  expectedStates: SagaState[],
  options: WaitForOptions = {},
): Promise<SagaItem> {
  return waitFor(
    async () => {
      const saga = await getSaga(sagaTableName, transferId);
      return saga && expectedStates.includes(saga.state) ? saga : undefined;
    },
    { description: `saga ${transferId} to reach state in [${expectedStates.join(", ")}]`, ...options },
  );
}

// 口座名義インデックス(`crates/transfer-service/src/bin/owner_projector.rs`、docs/adr/0011)への
// 反映待ち。`account.event.Opened`のoutbox発行を経て投影されるため、これも`waitFor`で
// ポーリングする。
export async function waitForOwnerIndexed(
  ownerTableName: string,
  accountId: string,
  options: WaitForOptions = {},
): Promise<string> {
  return waitFor(
    async () => {
      const result = await doc().send(new GetCommand({ TableName: ownerTableName, Key: { accountId } }));
      const ownerId = result.Item?.ownerId as string | undefined;
      return ownerId ?? undefined;
    },
    { description: `account ${accountId} to appear in the owner index`, ...options },
  );
}

// テスト専用: 組戻し(recall)の時間窓(`RECALL_WINDOW`、saga.rs)の期限切れを、実時間24時間
// 待つ代わりに`updatedAt`を直接過去へ書き換えて模擬する(docs/e2e-scenarios.md J10)。
// アプリケーションの通常の書き込み経路(advance_saga_state)を経由しない、この検証だけの
// 裏口であることを明示するため、他のヘルパーとは呼び出し方を変えている
// (support/dlq.tsがDLQを直接操作するのと同じ位置づけ)。
export async function backdateSagaUpdatedAt(sagaTableName: string, transferId: string, hoursAgo: number): Promise<void> {
  const backdated = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  await doc().send(
    new UpdateCommand({
      TableName: sagaTableName,
      Key: { transferId },
      UpdateExpression: "SET updatedAt = :t",
      ExpressionAttributeValues: { ":t": backdated },
    }),
  );
}

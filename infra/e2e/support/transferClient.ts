import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { REGION } from "../../support/stackOutputs";

// Transfer受付キュー(`moneta-transfer-commands-main.fifo`)への直接SendMessage
// (docs/adr/0010決定6: 顧客向けAPI Gatewayはまだ無く、SQS直接投入のみ)。
// メッセージ本文の形はcrates/transfer-service/src/bin/command_intake.rsの
// `TransferCommand`(serdeのデフォルト外部タグ付け)と一致させる——コード共有はせず
// 独立に定義する(infra/e2e/support/httpClient.tsがaccount-serviceの契約を独立に
// 保持しているのと同じ理由、docs/adr/0011)。
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

let cachedClient: SQSClient | undefined;
function client(): SQSClient {
  if (!cachedClient) cachedClient = new SQSClient({ region: REGION });
  return cachedClient;
}

// FIFOキューなので`MessageGroupId`/`MessageDeduplicationId`が必須。同一transferIdに対する
// 一連の操作(Start→Confirm等)を`MessageGroupId`で直列化する——サガ状態のCAS
// (advance_saga_state)自体が並行更新に安全だが、直列化しておけば受付側での順序も揃う。
async function send(queueUrl: string, groupId: string, dedupSuffix: string, body: unknown): Promise<void> {
  await client().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: `${groupId}-${dedupSuffix}`,
    }),
  );
}

export async function startTransfer(queueUrl: string, input: StartTransferInput): Promise<void> {
  await send(queueUrl, input.transferId, "start", {
    Start: {
      transfer_id: input.transferId,
      from_account_id: input.fromAccountId,
      to_account_id: input.toAccountId,
      amount: input.amount,
    },
  });
}

export async function confirmTransfer(queueUrl: string, transferId: string): Promise<void> {
  await send(queueUrl, transferId, "confirm", { Confirm: { transfer_id: transferId } });
}

export async function cancelTransfer(queueUrl: string, transferId: string): Promise<void> {
  await send(queueUrl, transferId, "cancel", { Cancel: { transfer_id: transferId } });
}

export async function recallTransfer(queueUrl: string, input: RecallTransferInput): Promise<void> {
  await send(queueUrl, input.transferId, "recall", {
    Recall: { transfer_id: input.transferId, original_transfer_id: input.originalTransferId },
  });
}

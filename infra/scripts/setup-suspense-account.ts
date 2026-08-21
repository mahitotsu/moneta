#!/usr/bin/env node
// docs/adr/0028: 銀行所有の仮受金口座(サスペンス口座)を一度だけ開設する。ウォッチドッグ
// (transfer-saga-watchdog)が再送上限を超えた`Compensating`サガの確定的な退避先として使う——
// `owner_id`に実在しないCognito subを使うことで、docs/adr/0016の所有者検証(`Freeze`/
// `Unfreeze`/`Close`は`requested_by == owner_id`)だけを根拠に、どの顧客からのリクエストでも
// 構造的に凍結・解約できない口座になる。account-domain/account-serviceへの変更は一切不要。
//
// transfer-serviceがaccount-serviceへコマンドを送るのと全く同じ経路(docs/adr/0010決定1:
// コマンドAPI/Cognitoを経由せず、コマンドキューへ直接SendMessage)を使う——`requested_by`が
// 無いため、account-serviceの`resolve_owner_id`はこのOpenコマンドの`owner_id`を上書きしない。
//
// 冪等: `Command::Open`への2回目の送信は`DomainError::AccountAlreadyExists`として素通しされる
// だけの安全な操作(account-service側で却下されるのみ、実害なし)なので、このスクリプトは
// 常に送信してから`Active`になるまで待つ。
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { fetchStackOutputs, REGION } from "../support/stackOutputs";

const SUSPENSE_OWNER_ID = "system:suspense";
const SUSPENSE_OWNER_NAME = "銀行仮受金口座";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sqs = new SQSClient({ region: REGION });

async function waitForActive(accountsTableName: string, accountId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await doc.send(new GetCommand({ TableName: accountsTableName, Key: { accountId } }));
    if (result.Item?.status === "active") return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for suspense account ${accountId} to become active`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function main(): Promise<void> {
  const outputs = await fetchStackOutputs();
  console.log(`Setting up the suspense account (${outputs.suspenseAccountId}) on ${outputs.commandQueueUrl}...`);

  const envelope = {
    account_id: outputs.suspenseAccountId,
    command: {
      Open: { owner_id: SUSPENSE_OWNER_ID, owner_name: SUSPENSE_OWNER_NAME, initial_balance: "0.00" },
    },
  };
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: outputs.commandQueueUrl,
      MessageGroupId: outputs.suspenseAccountId,
      MessageDeduplicationId: crypto.randomUUID(),
      MessageBody: JSON.stringify(envelope),
    }),
  );

  await waitForActive(outputs.accountsTableName, outputs.suspenseAccountId);
  console.log(`Done. Suspense account ${outputs.suspenseAccountId} is active.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

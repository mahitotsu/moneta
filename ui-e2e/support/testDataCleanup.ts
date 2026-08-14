// api-e2e/support/testDataCleanup.tsの同型コピー(独立パッケージの方針、stackOutputs.tsと同じ
// 理由)。**送金の操作系テーブル(transfer-sagas/transfer-status-view)は対象外のまま**——
// あちらはsupport/transferClient.tsのstart()呼び出しでtransferIdを直接受け取れるが、ui-e2e/は
// TransferForm.tsxを実ブラウザ経由で操作するだけで、transferId自体を取得できるchoke pointが
// ない(ADR-0007の通りルーターを使わないSPAで、URLにも反映されない)。React内部を無理に
// page.evaluate()で覗くよりは、このギャップを正直に記録した上でinfra/scripts/clean-data.tsの
// 定期的な一括ワイプに任せる方を選んだ。
//
// ただし「送金」タブ自体が読む顧客ごとの送金履歴(docs/adr/0017、CustomerTransfersTable)は
// transferIdを知らなくても片付けられる——PKはownerIdであり、口座追跡(trackCreatedAccount)で
// 既にownerIdを持っているため、そのownerId宛の行をQueryしてまるごと削除すればよい
// (api-e2e/support/testDataCleanup.tsのdeleteAllCustomerTransfersForOwnerと同じ考え方)。
//
// account_events/processed_messagesを対象にしない理由もapi-e2e/support/testDataCleanup.tsと
// 同じ(追記専用ログ、TTL/アーカイブで扱うべきもの)。
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { REGION } from "./stackOutputs";
import type { StackOutputs } from "./stackOutputs";

let cachedDoc: DynamoDBDocumentClient | undefined;
function doc(): DynamoDBDocumentClient {
  if (!cachedDoc) cachedDoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cachedDoc;
}

interface TrackedAccount {
  accountId: string;
  ownerId: string;
}
const accountsPendingCleanup: TrackedAccount[] = [];

/** support/seed.tsのopenFreshAccountが、口座開設成功のたびに自動で呼ぶ。 */
export function trackCreatedAccount(accountId: string, ownerId: string): void {
  accountsPendingCleanup.push({ accountId, ownerId });
}

async function safeDelete(tableName: string, key: Record<string, unknown>): Promise<void> {
  try {
    await doc().send(new DeleteCommand({ TableName: tableName, Key: key }));
  } catch (err) {
    console.warn(`cleanupTestData: failed to delete from ${tableName} (key=${JSON.stringify(key)}): ${String(err)}`);
  }
}

async function deleteAccountHistoryRows(tableName: string, accountId: string): Promise<void> {
  try {
    const result = await doc().send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "accountId = :a",
        ExpressionAttributeValues: { ":a": accountId },
        ProjectionExpression: "accountId, sk",
      }),
    );
    await Promise.all((result.Items ?? []).map((item) => safeDelete(tableName, { accountId: item.accountId, sk: item.sk })));
  } catch (err) {
    console.warn(`cleanupTestData: failed to query ${tableName} for accountId ${accountId}: ${String(err)}`);
  }
}

async function deleteAccountNumberRow(tableName: string, accountId: string): Promise<void> {
  try {
    const result = await doc().send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "byAccountId",
        KeyConditionExpression: "accountId = :a",
        ExpressionAttributeValues: { ":a": accountId },
        ProjectionExpression: "accountNumber",
      }),
    );
    await Promise.all((result.Items ?? []).map((item) => safeDelete(tableName, { accountNumber: item.accountNumber })));
  } catch (err) {
    console.warn(`cleanupTestData: failed to query ${tableName} (byAccountId) for accountId ${accountId}: ${String(err)}`);
  }
}

async function deleteAllCustomerTransfersForOwner(tableName: string, ownerId: string): Promise<void> {
  try {
    const result = await doc().send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "ownerId = :o",
        ExpressionAttributeValues: { ":o": ownerId },
        ProjectionExpression: "ownerId, transferId",
      }),
    );
    await Promise.all(
      (result.Items ?? []).map((item) => safeDelete(tableName, { ownerId: item.ownerId, transferId: item.transferId })),
    );
  } catch (err) {
    console.warn(`cleanupTestData: failed to query ${tableName} for ownerId ${ownerId}: ${String(err)}`);
  }
}

/** support/fixtures.tsのworker-scopedフィクスチャから呼ぶ、ワーカー単位の一括クリーンアップ。 */
export async function cleanupTestData(outputs: StackOutputs): Promise<void> {
  const accounts = accountsPendingCleanup.splice(0, accountsPendingCleanup.length);
  const owners = new Set(accounts.map((a) => a.ownerId));

  await Promise.all([
    ...accounts.flatMap(({ accountId, ownerId }) => [
      safeDelete(outputs.accountsTableName, { accountId }),
      safeDelete(outputs.accountViewTableName, { accountId }),
      safeDelete(outputs.transferAccountOwnersTableName, { accountId }),
      safeDelete(outputs.customerAccountsTableName, { ownerId, accountId }),
      deleteAccountHistoryRows(outputs.accountHistoryTableName, accountId),
      deleteAccountNumberRow(outputs.accountNumbersTableName, accountId),
    ]),
    ...Array.from(owners, (ownerId) => deleteAllCustomerTransfersForOwner(outputs.customerTransfersTableName, ownerId)),
  ]);
}

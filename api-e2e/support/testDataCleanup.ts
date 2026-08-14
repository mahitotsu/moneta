// support/auth.tsのCognitoユーザーteardownと対になる、口座・送金データのteardown
// (2026-08-14発覚: Cognitoユーザーと同じくaccountId/transferIdがUUIDで衝突しないことを理由に
// 「クリーンアップ不要」としてきたが、DynamoDBには合計5000件超のテスト由来データが溜まって
// いた)。
//
// account_events(監査ログ)とprocessed_messages(冪等性の重複排除ログ)はここでは対象にしない
// ——追記専用の設計そのものであり、本来はTTL/アーカイブで扱うべきもので、個々のテストのたびに
// 特定のaccountId分だけ削除するのはむしろその設計意図に反する(削除するとしても
// infra/scripts/clean-data.tsの全件ワイプの役目)。ここで消すのは、口座・送金の「現在状態」を
// 表すread-side/operationalテーブルのみ:テストが積み上がるとGET一覧やUI確認時のノイズになる
// 範囲。
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
const transfersPendingCleanup: string[] = [];

/** support/httpClient.tsのcreateCommandApiが、openAccount成功のたびに自動で呼ぶ
 * (呼び出し元のシナリオファイルが個別に呼ぶ必要はない、support/auth.tsのsignUpAndSignInが
 * 自動でaccessTokenを追跡するのと同じ設計)。 */
export function trackCreatedAccount(accountId: string, ownerId: string): void {
  accountsPendingCleanup.push({ accountId, ownerId });
}

/** support/transferClient.tsのcreateTransferCommandApiが、start成功のたびに自動で呼ぶ。 */
export function trackCreatedTransfer(transferId: string): void {
  transfersPendingCleanup.push(transferId);
}

async function safeDelete(tableName: string, key: Record<string, unknown>): Promise<void> {
  try {
    await doc().send(new DeleteCommand({ TableName: tableName, Key: key }));
  } catch (err) {
    console.warn(`cleanupTestData: failed to delete from ${tableName} (key=${JSON.stringify(key)}): ${String(err)}`);
  }
}

// account_history(PK accountId, SK sk)はSKがナノ秒タイムスタンプ+event_idで事前に分からない
// ため、まずQueryで該当accountIdの全行のキーだけ取り出してから個別に削除する
// (accountIdがパーティションキーなのでQueryは安価、フルスキャンではない)。
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

// account_numbers(PK accountNumber)はaccountId自体では引けないため、byAccountId GSI
// (docs/adr/0015、ALL射影)で実際のPKを解決してから削除する。
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

/** jest.setup.tsのafterAllから呼ぶ、テストファイル単位の一括クリーンアップ。1件の削除失敗が
 * 他の削除やテスト結果そのものを巻き込まないよう、失敗はログに残すのみで例外を投げない
 * (support/auth.tsのcleanupSignedUpUsersと同じ考え方)。 */
export async function cleanupTestData(outputs: StackOutputs): Promise<void> {
  const accounts = accountsPendingCleanup.splice(0, accountsPendingCleanup.length);
  const transfers = transfersPendingCleanup.splice(0, transfersPendingCleanup.length);

  await Promise.all([
    ...accounts.flatMap(({ accountId, ownerId }) => [
      safeDelete(outputs.accountsTableName, { accountId }),
      safeDelete(outputs.accountViewTableName, { accountId }),
      safeDelete(outputs.transferAccountOwnersTableName, { accountId }),
      safeDelete(outputs.customerAccountsTableName, { ownerId, accountId }),
      deleteAccountHistoryRows(outputs.accountHistoryTableName, accountId),
      deleteAccountNumberRow(outputs.accountNumbersTableName, accountId),
    ]),
    ...transfers.flatMap((transferId) => [
      safeDelete(outputs.transferSagaTableName, { transferId }),
      safeDelete(outputs.transferStatusViewTableName, { transferId }),
    ]),
  ]);
}

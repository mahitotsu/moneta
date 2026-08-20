#!/usr/bin/env node
// docs/adr/0027決定1・決定2: item単位の読み取り認可(GET /accounts/{id}・
// GET /accounts/{id}/transactions・GET /transfers/{id}の403判定)は、AccountViewTable・
// AccountHistoryTable・TransferStatusViewTableの各アイテムが持つownerId/fromOwnerId/toOwnerId
// 属性を見て行う。これらの属性は新しいイベント(query_projector.rs/transfer_status_projector.rs)
// によってのみ書かれるため、デプロイ時点で既に存在するアイテムは持っていない——認可の安全側の
// デフォルトは「属性が無ければ拒否」なので、そのまま放置すると既存のdemoデータ・実運用中の
// 口座/送金が全て403になってしまう。このスクリプトはデプロイ直後に一度だけ実行し、既存アイテムへ
// 属性を補完する。
//
// account-serviceの内部テーブル(accounts)・transfer-serviceの内部テーブル(TransferSagaTable)を
// 直接読む——通常のLambdaコード(query-service/transfer-service)ならcrate境界違反になる
// (ADR-0008)が、このスクリプトはどのサービスのコードパスでもない独立した運用ツールであり、
// clean-data.tsが既に複数サービスのテーブルを横断しているのと同じ扱い。
//
// べき等: 既にownerId(またはfromOwnerId/toOwnerId)を持つアイテムはスキップする——何度実行しても
// 安全。
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { fetchStackOutputs, REGION } from "../support/stackOutputs";

const client = new DynamoDBClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(client);

async function scanAll(tableName: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }));
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

async function batchPutItems(tableName: string, items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    let requestItems: Record<string, { PutRequest: { Item: Record<string, unknown> } }[]> = {
      [tableName]: chunk.map((item) => ({ PutRequest: { Item: item } })),
    };
    while (Object.keys(requestItems).length > 0) {
      const result = await doc.send(new BatchWriteCommand({ RequestItems: requestItems }));
      requestItems = (result.UnprocessedItems ?? {}) as typeof requestItems;
    }
  }
}

/** accountId(またはtransferId)から名義を引く単純なMap。取りこぼしがあれば個別にログを出す。 */
async function backfillAccountOwnership(
  accountsTableName: string,
  accountViewTableName: string,
  accountHistoryTableName: string,
): Promise<void> {
  const accounts = await scanAll(accountsTableName);
  const ownerByAccountId = new Map<string, string>();
  for (const item of accounts) {
    const accountId = item.accountId as string;
    const ownerId = item.ownerId as string | undefined;
    if (accountId && ownerId) ownerByAccountId.set(accountId, ownerId);
  }
  console.log(`[accounts] loaded ${ownerByAccountId.size} account -> owner mappings`);

  for (const [tableName, label] of [
    [accountViewTableName, "AccountViewTable"],
    [accountHistoryTableName, "AccountHistoryTable"],
  ] as const) {
    const items = await scanAll(tableName);
    const toBackfill: Record<string, unknown>[] = [];
    let missingOwner = 0;
    for (const item of items) {
      if (item.ownerId) continue;
      const ownerId = ownerByAccountId.get(item.accountId as string);
      if (!ownerId) {
        missingOwner += 1;
        continue;
      }
      toBackfill.push({ ...item, ownerId });
    }
    await batchPutItems(tableName, toBackfill);
    console.log(
      `[${label}] ${items.length} items scanned, ${toBackfill.length} backfilled, ` +
        `${items.length - toBackfill.length - missingOwner} already had ownerId, ${missingOwner} had no matching account`,
    );
  }
}

async function backfillTransferOwnership(
  transferSagaTableName: string,
  transferStatusViewTableName: string,
): Promise<void> {
  const sagas = await scanAll(transferSagaTableName);
  const ownersByTransferId = new Map<string, { fromOwnerId: string; toOwnerId: string }>();
  for (const item of sagas) {
    const transferId = item.transferId as string;
    const fromOwnerId = item.fromOwnerId as string | undefined;
    const toOwnerId = item.toOwnerId as string | undefined;
    if (transferId && fromOwnerId && toOwnerId) ownersByTransferId.set(transferId, { fromOwnerId, toOwnerId });
  }
  console.log(`[TransferSagaTable] loaded ${ownersByTransferId.size} transfer -> owner mappings`);

  const items = await scanAll(transferStatusViewTableName);
  const toBackfill: Record<string, unknown>[] = [];
  let missingOwner = 0;
  for (const item of items) {
    if (item.fromOwnerId && item.toOwnerId) continue;
    const owners = ownersByTransferId.get(item.transferId as string);
    if (!owners) {
      missingOwner += 1;
      continue;
    }
    toBackfill.push({ ...item, fromOwnerId: owners.fromOwnerId, toOwnerId: owners.toOwnerId });
  }
  await batchPutItems(transferStatusViewTableName, toBackfill);
  console.log(
    `[TransferStatusViewTable] ${items.length} items scanned, ${toBackfill.length} backfilled, ` +
      `${items.length - toBackfill.length - missingOwner} already had owners, ${missingOwner} had no matching saga`,
  );
}

async function main(): Promise<void> {
  const outputs = await fetchStackOutputs();
  await backfillAccountOwnership(outputs.accountsTableName, outputs.accountViewTableName, outputs.accountHistoryTableName);
  await backfillTransferOwnership(outputs.transferSagaTableName, outputs.transferStatusViewTableName);
  console.log("\nDone.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

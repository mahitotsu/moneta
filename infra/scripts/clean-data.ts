#!/usr/bin/env node
// Resets test data in the deployed dev stack to a clean slate, without touching any
// table/schema definitions. Exported functions are reusable from future test code;
// running this file directly (`npm run clean-data`) drives them from a CLI.
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { PurgeQueueCommand, PurgeQueueInProgress, SQSClient } from "@aws-sdk/client-sqs";
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { fetchStackOutputs, REGION, STACK_NAME, StackOutputs } from "../support/stackOutputs";
import { DEMO_USERNAMES } from "./seed-demo-data";

export { fetchStackOutputs };
export type { StackOutputs };

interface DynamoTableSpec {
  tableName: string;
  keyAttributes: string[];
  /** protectのpredicateが参照する、keyAttributes以外の追加射影属性。 */
  protectAttributes?: string[];
  /** trueを返す項目は削除対象から除外する(scripts/seed-demo-data.tsのデモデータ保護)。 */
  protect?: (item: Record<string, unknown>) => boolean;
}

async function batchDeleteKeys(
  doc: DynamoDBDocumentClient,
  tableName: string,
  keys: Record<string, unknown>[],
): Promise<void> {
  let requestItems: Record<string, { DeleteRequest: { Key: Record<string, unknown> } }[]> = {
    [tableName]: keys.map((key) => ({ DeleteRequest: { Key: key } })),
  };
  while (Object.keys(requestItems).length > 0) {
    const result = await doc.send(new BatchWriteCommand({ RequestItems: requestItems }));
    requestItems = (result.UnprocessedItems ?? {}) as typeof requestItems;
  }
}

interface ClearResult {
  deleted: number;
  skipped: number;
}

async function clearDynamoTable(doc: DynamoDBDocumentClient, spec: DynamoTableSpec): Promise<ClearResult> {
  const attrs = [...new Set([...spec.keyAttributes, ...(spec.protectAttributes ?? [])])];
  const expressionAttributeNames: Record<string, string> = {};
  const projection = attrs.map((attr, i) => {
    const placeholder = `#k${i}`;
    expressionAttributeNames[placeholder] = attr;
    return placeholder;
  });

  let deleted = 0;
  let skipped = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: spec.tableName,
        ProjectionExpression: projection.join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = page.Items ?? [];
    const keysToDelete: Record<string, unknown>[] = [];
    for (const item of items) {
      if (spec.protect?.(item)) {
        skipped += 1;
        continue;
      }
      keysToDelete.push(Object.fromEntries(spec.keyAttributes.map((k) => [k, item[k]])));
    }
    for (let i = 0; i < keysToDelete.length; i += 25) {
      const chunk = keysToDelete.slice(i, i + 25);
      await batchDeleteKeys(doc, spec.tableName, chunk);
      deleted += chunk.length;
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return { deleted, skipped };
}

// scripts/seed-demo-data.tsが作った口座・送金を一括削除の対象から外す(2026-08-14追加)。
// demo-customer/demo-customer-2のCognito subは再デプロイのたびに変わるため固定値を持てず、
// 都度Cognitoへ引き直す——ユーザー名(DEMO_USERNAMES)だけが安定した目印になる。デモユーザーが
// まだ存在しない(seed-demo-data.tsが一度も実行されていない)場合は空集合を返し、保護対象なしで
// 続行する。
async function resolveDemoProtectedIds(outputs: StackOutputs): Promise<{ accountIds: Set<string>; transferIds: Set<string> }> {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  const ownerIds: string[] = [];
  for (const username of DEMO_USERNAMES) {
    const result = await cognito.send(
      new ListUsersCommand({ UserPoolId: outputs.userPoolId, Filter: `username = "${username}"` }),
    );
    const sub = result.Users?.[0]?.Attributes?.find((a) => a.Name === "sub")?.Value;
    if (sub) ownerIds.push(sub);
  }

  const accountIds = new Set<string>();
  for (const ownerId of ownerIds) {
    const result = await doc.send(
      new QueryCommand({
        TableName: outputs.customerAccountsTableName,
        KeyConditionExpression: "ownerId = :o",
        ExpressionAttributeValues: { ":o": ownerId },
        ProjectionExpression: "accountId",
      }),
    );
    for (const item of result.Items ?? []) accountIds.add(item.accountId as string);
  }

  // TransferStatusViewTableは小さい(顧客向けの状態ビュー1件=1送金)ので、フルスキャンで
  // fromAccountId/toAccountIdが保護対象口座に触れる送金を洗い出す。
  const transferIds = new Set<string>();
  if (accountIds.size > 0) {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await doc.send(
        new ScanCommand({
          TableName: outputs.transferStatusViewTableName,
          ProjectionExpression: "transferId, fromAccountId, toAccountId",
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const item of page.Items ?? []) {
        if (accountIds.has(item.fromAccountId as string) || accountIds.has(item.toAccountId as string)) {
          transferIds.add(item.transferId as string);
        }
      }
      exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
  }

  return { accountIds, transferIds };
}

export async function cleanDynamoDb(outputs: StackOutputs): Promise<Record<string, ClearResult>> {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const protectedIds = await resolveDemoProtectedIds(outputs);
  if (protectedIds.accountIds.size > 0) {
    console.log(
      `[dynamodb] protecting ${protectedIds.accountIds.size} demo account(s) and ` +
        `${protectedIds.transferIds.size} demo transfer(s) from deletion (scripts/seed-demo-data.ts)`,
    );
  }
  const protectByAccountId = (item: Record<string, unknown>) => protectedIds.accountIds.has(item.accountId as string);
  const protectByTransferId = (item: Record<string, unknown>) => protectedIds.transferIds.has(item.transferId as string);

  // infra/lib/account-pipeline-stack.ts: account-service自身の3テーブル(docs/adr/0013)に加え、
  // query-service/transfer-serviceが所有する残り7テーブルも全て対象にする(2026-08-14修正:
  // このリストは元々account-service分の5テーブルしかカバーしておらず、docs/adr/0010以降に
  // 増えた5テーブルが一度も一括ワイプの対象になっていなかった)。processedMessages(冪等性キーの
  // 重複排除テーブル)もクリアしないと、リセット後に同じIdempotency-Keyを再送してもサイレントに
  // no-opしてしまう。AccountViewTable/AccountHistoryTable/CustomerAccountsTableの主キーは
  // account-serviceのpersistence.rs・query-service/transfer-serviceの各投影の実装通り
  // (docs/adr/0004・0011・0015・0016)。
  const specs: DynamoTableSpec[] = [
    { tableName: outputs.accountsTableName, keyAttributes: ["accountId"], protect: protectByAccountId },
    {
      tableName: outputs.accountEventsTableName,
      keyAttributes: ["eventId"],
      protectAttributes: ["accountId"],
      protect: protectByAccountId,
    },
    {
      tableName: outputs.processedMessagesTableName,
      keyAttributes: ["messageId"],
      protectAttributes: ["accountId"],
      protect: protectByAccountId,
    },
    { tableName: outputs.accountViewTableName, keyAttributes: ["accountId"], protect: protectByAccountId },
    { tableName: outputs.accountHistoryTableName, keyAttributes: ["accountId", "sk"], protect: protectByAccountId },
    {
      tableName: outputs.accountNumbersTableName,
      keyAttributes: ["accountNumber"],
      protectAttributes: ["accountId"],
      protect: protectByAccountId,
    },
    {
      tableName: outputs.customerAccountsTableName,
      keyAttributes: ["ownerId", "accountId"],
      protect: protectByAccountId,
    },
    { tableName: outputs.transferAccountOwnersTableName, keyAttributes: ["accountId"], protect: protectByAccountId },
    { tableName: outputs.transferSagaTableName, keyAttributes: ["transferId"], protect: protectByTransferId },
    { tableName: outputs.transferStatusViewTableName, keyAttributes: ["transferId"], protect: protectByTransferId },
  ];

  const counts: Record<string, ClearResult> = {};
  for (const spec of specs) {
    counts[spec.tableName] = await clearDynamoTable(doc, spec);
  }
  return counts;
}

export async function cleanSqs(outputs: StackOutputs): Promise<void> {
  const sqs = new SQSClient({ region: REGION });
  for (const queueUrl of [outputs.commandQueueUrl, outputs.deadLetterQueueUrl]) {
    try {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
      console.log(`[sqs] purge requested for ${queueUrl} (asynchronous, can take up to ~60s)`);
    } catch (err) {
      if (err instanceof PurgeQueueInProgress) {
        // AWS allows only one purge per queue per 60s.
        console.warn(`[sqs] purge already in progress for ${queueUrl}, skipping`);
        continue;
      }
      throw err;
    }
  }
}

// api-e2e/support/auth.ts・ui-e2e/support/auth.tsのsignUpAndSignIn()が作る使い捨てユーザーの
// ユーザー名プレフィックス。本物の(手動で試した)ユーザーを誤って消さないよう、このプレフィックス
// に一致するものだけを対象にする。両ハーネスとも今はテストごとのteardown(jest.setup.ts/
// support/fixtures.ts)で自動削除するようになったが、2026-08-14時点でteardown導入前に溜まった
// 分と、teardownが何らかの理由で走らなかった分(異常終了等)の掃き出し用にこのtargetを残す。
const E2E_COGNITO_USERNAME_PREFIXES = ["e2e-", "ui-e2e-"];

export async function cleanCognito(outputs: StackOutputs): Promise<number> {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  let deleted = 0;
  let paginationToken: string | undefined;
  do {
    const page = await cognito.send(
      new ListUsersCommand({ UserPoolId: outputs.userPoolId, PaginationToken: paginationToken }),
    );
    const targets = (page.Users ?? []).filter(
      (u) => u.Username && E2E_COGNITO_USERNAME_PREFIXES.some((prefix) => u.Username!.startsWith(prefix)),
    );
    for (const user of targets) {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: outputs.userPoolId, Username: user.Username! }));
      deleted += 1;
    }
    paginationToken = page.PaginationToken;
  } while (paginationToken);
  return deleted;
}

const CLEAN_TARGETS = ["dynamodb", "sqs", "cognito"] as const;
type CleanTarget = (typeof CLEAN_TARGETS)[number];

function parseArgs(argv: string[]): { yes: boolean; only: CleanTarget[] } {
  let yes = false;
  let only: CleanTarget[] = [...CLEAN_TARGETS];

  for (const arg of argv) {
    if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg.startsWith("--only=")) {
      const requested = arg
        .slice("--only=".length)
        .split(",")
        .map((s) => s.trim());
      for (const r of requested) {
        if (!(CLEAN_TARGETS as readonly string[]).includes(r)) {
          throw new Error(`Unknown --only target "${r}" (expected one of ${CLEAN_TARGETS.join(", ")})`);
        }
      }
      only = requested as CleanTarget[];
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }

  return { yes, only };
}

async function confirm(promptText: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(promptText);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { yes, only } = parseArgs(process.argv.slice(2));

  console.log(`Fetching outputs for stack "${STACK_NAME}" in ${REGION}...`);
  const outputs = await fetchStackOutputs();

  console.log("\nThis will permanently delete data from:");
  if (only.includes("dynamodb")) {
    console.log(
      `  - DynamoDB tables: ${outputs.accountsTableName}, ${outputs.accountEventsTableName}, ` +
        `${outputs.processedMessagesTableName}, ${outputs.accountViewTableName}, ${outputs.accountHistoryTableName}, ` +
        `${outputs.accountNumbersTableName}, ${outputs.customerAccountsTableName}, ` +
        `${outputs.transferAccountOwnersTableName}, ${outputs.transferSagaTableName}, ` +
        `${outputs.transferStatusViewTableName}`,
    );
    console.log(`    (protects scripts/seed-demo-data.ts's demo-customer/demo-customer-2 data, if any)`);
  }
  if (only.includes("sqs")) {
    console.log(`  - SQS queues: ${outputs.commandQueueUrl}, ${outputs.deadLetterQueueUrl}`);
  }
  if (only.includes("cognito")) {
    console.log(
      `  - Cognito User Pool ${outputs.userPoolId}: users whose username starts with ` +
        `${E2E_COGNITO_USERNAME_PREFIXES.join(" or ")} (leaves any manually-created user alone)`,
    );
  }

  if (!yes && !(await confirm("\nProceed? [y/N] "))) {
    console.log("Aborted.");
    return;
  }

  if (only.includes("dynamodb")) {
    const results = await cleanDynamoDb(outputs);
    for (const [table, { deleted, skipped }] of Object.entries(results)) {
      const protectedNote = skipped > 0 ? ` (protected ${skipped} demo item(s))` : "";
      console.log(`[dynamodb] deleted ${deleted} item(s) from ${table}${protectedNote}`);
    }
  }
  if (only.includes("sqs")) {
    await cleanSqs(outputs);
  }
  if (only.includes("cognito")) {
    const deleted = await cleanCognito(outputs);
    console.log(`[cognito] deleted ${deleted} test user(s) from ${outputs.userPoolId}`);
  }

  console.log("\nDone.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

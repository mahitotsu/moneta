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
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { PurgeQueueCommand, PurgeQueueInProgress, SQSClient } from "@aws-sdk/client-sqs";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { Client as PgClient } from "pg";
import { fetchStackOutputs, REGION, STACK_NAME, StackOutputs } from "../support/stackOutputs";

export { fetchStackOutputs };
export type { StackOutputs };

// crates/account-service/schema.sql. No FK relationships between these, so delete order
// doesn't matter, but processed_messages (the idempotency-key dedup table) must be cleared
// too or replaying an Idempotency-Key after a reset silently no-ops.
const DSQL_TABLES = ["account_events", "processed_messages", "accounts"] as const;

// SQLSTATEs Aurora DSQL uses for optimistic-concurrency conflicts (docs/adr/0002).
const OCC_SQLSTATES = new Set(["OC000", "OC001", "40001"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execWithOccRetry(client: PgClient, sql: string, maxAttempts = 3): Promise<number> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await client.query(sql);
      return result.rowCount ?? 0;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && OCC_SQLSTATES.has(code) && attempt < maxAttempts) {
        await sleep(200 * attempt);
        continue;
      }
      throw err;
    }
  }
}

// Deletes require the DSQL *admin* role: the runtime app role (account_service_app) only
// has SELECT/INSERT/UPDATE granted, not DELETE (crates/account-service/src/bin/schema_migrator.rs).
export async function cleanDsql(outputs: StackOutputs): Promise<Record<string, number>> {
  const signer = new DsqlSigner({ hostname: outputs.clusterEndpoint, region: REGION });
  const token = await signer.getDbConnectAdminAuthToken();
  const client = new PgClient({
    host: outputs.clusterEndpoint,
    port: 5432,
    database: "postgres",
    user: "admin",
    password: token,
    ssl: true,
  });

  await client.connect();
  try {
    const counts: Record<string, number> = {};
    for (const table of DSQL_TABLES) {
      counts[table] = await execWithOccRetry(client, `DELETE FROM ${table}`);
    }
    return counts;
  } finally {
    await client.end();
  }
}

interface DynamoTableSpec {
  tableName: string;
  keyAttributes: string[];
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

async function clearDynamoTable(doc: DynamoDBDocumentClient, spec: DynamoTableSpec): Promise<number> {
  const expressionAttributeNames: Record<string, string> = {};
  const projection = spec.keyAttributes.map((attr, i) => {
    const placeholder = `#k${i}`;
    expressionAttributeNames[placeholder] = attr;
    return placeholder;
  });

  let deleted = 0;
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
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      await batchDeleteKeys(doc, spec.tableName, chunk);
      deleted += chunk.length;
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return deleted;
}

export async function cleanDynamoDb(outputs: StackOutputs): Promise<Record<string, number>> {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  // infra/lib/account-pipeline-stack.ts: AccountViewTable's key is accountId only;
  // AccountHistoryTable's key is accountId + sk (docs/adr/0009).
  const specs: DynamoTableSpec[] = [
    { tableName: outputs.accountViewTableName, keyAttributes: ["accountId"] },
    { tableName: outputs.accountHistoryTableName, keyAttributes: ["accountId", "sk"] },
  ];

  const counts: Record<string, number> = {};
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

const CLEAN_TARGETS = ["dsql", "dynamodb", "sqs"] as const;
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
  if (only.includes("dsql")) {
    console.log(`  - DSQL cluster ${outputs.clusterEndpoint}: tables ${DSQL_TABLES.join(", ")}`);
  }
  if (only.includes("dynamodb")) {
    console.log(`  - DynamoDB tables: ${outputs.accountViewTableName}, ${outputs.accountHistoryTableName}`);
  }
  if (only.includes("sqs")) {
    console.log(`  - SQS queues: ${outputs.commandQueueUrl}, ${outputs.deadLetterQueueUrl}`);
  }

  if (!yes && !(await confirm("\nProceed? [y/N] "))) {
    console.log("Aborted.");
    return;
  }

  if (only.includes("dsql")) {
    const counts = await cleanDsql(outputs);
    for (const [table, count] of Object.entries(counts)) {
      console.log(`[dsql] deleted ${count} row(s) from ${table}`);
    }
  }
  if (only.includes("dynamodb")) {
    const counts = await cleanDynamoDb(outputs);
    for (const [table, count] of Object.entries(counts)) {
      console.log(`[dynamodb] deleted ${count} item(s) from ${table}`);
    }
  }
  if (only.includes("sqs")) {
    await cleanSqs(outputs);
  }

  console.log("\nDone.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

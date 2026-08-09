// Duplicated from api-e2e/support/sagaState.ts's waitForOwnerIndexed (same reasoning as
// stackOutputs.ts: independent packages, no cross-import). Waits for the account-owner index
// (`crates/transfer-service/src/bin/owner_projector.rs`, docs/adr/0011) to reflect a
// just-opened account before starting a furikomi -- otherwise `transfer-command-intake`
// retries internally until it appears, which works but just makes the spec slower and muddies
// what it's actually timing. This is a read against an internal projection table with no
// corresponding public API (docs/adr/0012 only added a status-query API for the saga itself),
// same as api-e2e's copy -- not a new kind of backdoor.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { REGION } from "./stackOutputs";

let cachedDoc: DynamoDBDocumentClient | undefined;
function doc(): DynamoDBDocumentClient {
  if (!cachedDoc) cachedDoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cachedDoc;
}

export async function waitForOwnerIndexed(
  ownerTableName: string,
  accountId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await doc().send(new GetCommand({ TableName: ownerTableName, Key: { accountId } }));
    if (result.Item?.ownerId) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for account ${accountId} to appear in the owner index`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

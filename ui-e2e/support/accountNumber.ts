// Given-step helper: resolves a just-opened account's human-readable account number (branch +
// 7-digit number, docs/adr/0015) directly over HTTP against the raw AccountNumberQueryApi URL
// (not the CloudFront-proxied relative path web-ui itself uses, same reasoning as seed.ts).
// Unlike ownerIndex.ts's direct-DynamoDB read, this one goes through the public query API --
// account-number-projector's table has one (unlike the owner index), so there's no reason to
// reach past it. AccountNumberQueryApi requires Cognito auth (docs/adr/0016決定2) -- any signed-in
// identity's idToken works, since this endpoint answers "what number does accountId X have", not
// "what accounts does the caller own".
import type { StackOutputs } from "./stackOutputs";

export interface AccountNumberLookup {
  accountId: string;
  ownerId: string;
  accountNumber: string;
  branchCode: string;
  branchName: string;
}

/** account-number-projectorの反映を待つ(結果整合性、docs/adr/0015)。ownerIndex.tsの
 * waitForOwnerIndexedと同じ理由でfurikomiを始める前に呼ぶ——さもないと反映待ちのまま
 * スペックが遅くなるだけで、何を計測しているのか分かりにくくなる。 */
export async function waitForAccountNumber(
  outputs: Pick<StackOutputs, "accountNumberQueryApiUrl">,
  accountId: string,
  idToken: string,
  timeoutMs = 30_000,
): Promise<AccountNumberLookup> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${outputs.accountNumberQueryApiUrl}/accounts/${accountId}/account-number`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (response.status === 200) {
      return (await response.json()) as AccountNumberLookup;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for account ${accountId} to get a friendly account number`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

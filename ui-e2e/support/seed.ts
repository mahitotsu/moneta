// Given-step helper: opens a fresh, Active account directly over HTTP against the raw
// account-service command/query API Gateway URLs (not the CloudFront-proxied relative paths
// web-ui itself uses, docs/adr/0007) so specs don't have to drive the "口座を開設" UI flow
// through a browser to get there -- that flow has no transfer-specific behavior of its own and
// isn't part of the gap ui-e2e/ exists to cover (docs/adr/0014). Deliberately a much smaller
// surface than api-e2e/support/httpClient.ts's CommandApi/QueryApi (open + poll-active only):
// ui-e2e/ doesn't need deposit/withdraw/freeze/etc., and duplicating the unused half of that
// interface here would just be more code to keep in sync for no benefit.
//
// docs/adr/0016以降、AccountCommandApi/AccountQueryApiは共にCognito認証必須になり、owner_idも
// もはやリクエストボディの自己申告値ではなく認証済みJWTのsubから決まる(決定3)。呼び出し側は
// support/auth.tsのsignUpAndSignInで得たidTokenを渡す——それがそのままこの口座のownerIdになる。
import type { StackOutputs } from "./stackOutputs";
import { subFromIdToken } from "./auth";
import { trackCreatedAccount } from "./testDataCleanup";

interface AccountView {
  status: "active" | "frozen" | "closed";
  balance: string;
}

interface MyAccount {
  accountId: string;
}

async function waitForActive(queryApiUrl: string, accountId: string, idToken: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${queryApiUrl}/accounts/${accountId}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (response.status === 200) {
      const view = (await response.json()) as AccountView;
      if (view.status === "active") return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for account ${accountId} to become active`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

// customer-accounts-projector(docs/adr/0016決定4)の反映を待つ。web-uiのAccountListScreenは
// これが埋まるまで「口座」タブに何も表示しないので、seedの時点で先に待っておかないと、
// page.goto()直後のspecがまだ空のリストを見てしまう(account-number-projector等と同じ
// 結果整合性のラグ、docs/adr/0004の慣行)。
async function waitForListedInMyAccounts(
  queryApiUrl: string,
  accountId: string,
  idToken: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${queryApiUrl}/customers/me/accounts`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (response.status === 200) {
      const accounts = (await response.json()) as MyAccount[];
      if (accounts.some((a) => a.accountId === accountId)) return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for account ${accountId} to appear in GET /customers/me/accounts`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Mirrors api-e2e/support/testAccount.ts's openFreshAccount: client-generated account ID
 * (docs/adr/0006決定2), so each spec gets a never-before-used UUID and specs don't need shared
 * fixtures or cleanup between runs to stay isolated. */
export async function openFreshAccount(
  outputs: Pick<StackOutputs, "commandApiUrl" | "queryApiUrl">,
  idToken: string,
  initialBalance: string,
): Promise<string> {
  const accountId = crypto.randomUUID();
  const response = await fetch(`${outputs.commandApiUrl}/accounts/${accountId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ initial_balance: initialBalance }),
  });
  if (response.status !== 202) {
    throw new Error(`openAccount(${accountId}) unexpected status ${response.status}: ${await response.text()}`);
  }
  await waitForActive(outputs.queryApiUrl, accountId, idToken);
  await waitForListedInMyAccounts(outputs.queryApiUrl, accountId, idToken);

  // support/testDataCleanup.tsのteardownに乗せる(2026-08-14発覚: 口座データもCognito
  // ユーザーと同じく際限なく積み上がっていた)。
  const ownerId = subFromIdToken(idToken);
  if (ownerId) trackCreatedAccount(accountId, ownerId);

  return accountId;
}

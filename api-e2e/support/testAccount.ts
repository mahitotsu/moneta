import { AccountView, CommandApi, QueryApi } from "./httpClient";
import { waitFor } from "./poll";

export async function waitForStatus(
  queryApi: QueryApi,
  accountId: string,
  status: AccountView["status"],
): Promise<AccountView> {
  return waitFor(
    async () => {
      const view = await queryApi.getAccount(accountId);
      return view?.status === status ? view : undefined;
    },
    { description: `account ${accountId} to reach status "${status}"` },
  );
}

// Given-step helper shared by most scenarios in docs/e2e-scenarios.md: a fresh, Active
// account with a known balance. Account IDs are client-generated (docs/adr/0006決定2), so
// each test gets its own never-before-used UUID -- tests don't need shared fixtures or a
// data reset between runs to stay isolated from each other.
//
// There is no `ownerId` parameter (removed, docs/adr/0016決定3): the account's real owner is
// no longer a string the client can assert in the request body -- OpenCommandModel no longer
// even accepts an `owner_id` property. It is now entirely determined by *which* Cognito
// identity `commandApi` was constructed with (`support/httpClient.ts`'s `createCommandApi`
// `idToken` argument), via API Gateway VTL injecting `$context.authorizer.claims.sub` as
// `requested_by`. Scenarios that need to distinguish furikae(同一名義)/furikomi(名義不一致)
// must instead call this with two `commandApi` instances built from two separate
// `support/auth.ts`'s `signUpAndSignIn()` results (same identity => furikae, different
// identities => furikomi).
export async function openFreshAccount(commandApi: CommandApi, queryApi: QueryApi, initialBalance: string): Promise<string> {
  const accountId = crypto.randomUUID();
  const response = await commandApi.openAccount(accountId, initialBalance);
  if (response.status !== 202) {
    throw new Error(`openAccount(${accountId}) unexpected status ${response.status}: ${JSON.stringify(response.body)}`);
  }
  await waitForStatus(queryApi, accountId, "active");
  return accountId;
}

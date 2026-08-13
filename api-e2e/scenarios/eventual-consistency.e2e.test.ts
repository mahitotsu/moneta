// Covers docs/e2e-scenarios.md P1 (旧F1) -- the read side (account_events' DynamoDB Streams ->
// EventBridge -> DynamoDB view, docs/adr/0004・0013) lags the write side, but converges quickly
// (DynamoDB Streams delivers near-real-time, unlike the old EventBridge Scheduler's ~1-minute
// floor). This is a documented property, not a failure (docs/adr/0001's UX accountability, and
// this project's "eventual consistency isn't a failure" stance) -- so what this test locks in is
// (a) it always converges within `waitFor`'s bounded timeout, and (b) every intermediate
// observation is one of the two coherent values, never something corrupted in between.
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";
import { signUpAndSignIn } from "../support/auth";

describe("F1: 結果整合性は失敗ではなく、境界のある遅延として収束する", () => {
  it(
    "入金直後の照会は古い残高を返しうるが、まもなく新残高へ収束する",
    async () => {
      const outputs = await fetchStackOutputs();
      const identity = await signUpAndSignIn(outputs.userPoolClientId);
      const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
      const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
      const accountId = await openFreshAccount(commandApi, queryApi, "0");

      const response = await commandApi.deposit(accountId, "10");
      expect(response.status).toBe(202);

      const observedBalances = new Set<number>();
      const view = await waitFor(
        async () => {
          const v = await queryApi.getAccount(accountId);
          if (v) observedBalances.add(Number(v.balance));
          return v && Number(v.balance) === 10 ? v : undefined;
        },
        { intervalMs: 500, description: `account ${accountId} balance to converge to 10` },
      );

      expect(view.status).toBe("active");
      for (const balance of observedBalances) {
        expect([0, 10]).toContain(balance);
      }
    },
    60_000,
  );
});

// Covers docs/e2e-scenarios.md F1 -- the read side (DSQL outbox -> EventBridge -> DynamoDB,
// docs/adr/0004) lags the write side by up to ~1 minute (EventBridge Scheduler's own floor).
// This is a documented property, not a failure (docs/adr/0001's UX accountability, and this
// project's "eventual consistency isn't a failure" stance) -- so what this test locks in is
// (a) it always converges within a bounded window, and (b) every intermediate observation is
// one of the two coherent values, never something corrupted in between.
//
// Unlike every other scenario in this suite, the final wait below passes `triggerRelay: false`.
// ADR-0004's claim is an *upper bound* ("up to ~1 minute"), not an exact latency, so it doesn't
// matter whether convergence happens quickly (including via some unrelated concurrently-running
// test's own relay invocation, support/relay.ts) or takes nearly the full window -- either is
// consistent with the bound. What `triggerRelay: false` actually guards against is this test
// invoking the relay itself, which would make it self-fulfilling (always "converges" instantly
// because the test forced it, proving nothing about whether the system does this on its own).
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";

describe("F1: 結果整合性は失敗ではなく、境界のある遅延として収束する", () => {
  it(
    "入金直後の照会は古い残高を返しうるが、最大150秒以内に新残高へ収束する",
    async () => {
      const outputs = await fetchStackOutputs();
      const commandApi = createCommandApi(outputs.commandApiUrl);
      const queryApi = createQueryApi(outputs.queryApiUrl);
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
        { intervalMs: 2_000, description: `account ${accountId} balance to converge to 10`, triggerRelay: false },
      );

      expect(view.status).toBe("active");
      for (const balance of observedBalances) {
        expect([0, 10]).toContain(balance);
      }
    },
    240_000,
  );
});

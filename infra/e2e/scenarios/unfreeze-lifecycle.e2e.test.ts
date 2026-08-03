// Covers docs/e2e-scenarios.md A7. Unlike the B-category fixture files, this one *must* use
// its own dedicated account: it walks the account through a real state transition (frozen ->
// active) rather than asserting a rejection, so it can't share a fixture with tests that assume
// the fixture never changes. That means four sequential eventual-consistency waits (open,
// freeze, unfreeze, deposit -- each bounded up to ~150s under load, support/poll.ts), hence the
// generous explicit per-test timeout below (the file-level default in jest.config.js is sized
// for one or two such waits, not four).
import { fetchStackOutputs } from "../../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { waitFor } from "../support/poll";
import { openFreshAccount, waitForStatus } from "../support/testAccount";

describe("A7: 凍結解除後は再度操作可能になる", () => {
  it(
    "凍結 → 凍結解除 → 入金が成功し、残高が増加する",
    async () => {
      const outputs = await fetchStackOutputs();
      const commandApi = createCommandApi(outputs.commandApiUrl);
      const queryApi = createQueryApi(outputs.queryApiUrl);
      const accountId = await openFreshAccount(commandApi, queryApi, "100");

      await commandApi.freeze(accountId, "CustomerRequest");
      await waitForStatus(queryApi, accountId, "frozen");

      await commandApi.unfreeze(accountId);
      await waitForStatus(queryApi, accountId, "active");

      const depositResponse = await commandApi.deposit(accountId, "25");
      expect(depositResponse.status).toBe(202);

      const view = await waitFor(
        async () => {
          const v = await queryApi.getAccount(accountId);
          return v && Number(v.balance) === 125 ? v : undefined;
        },
        { description: `account ${accountId} balance to reach 125 after post-unfreeze deposit` },
      );
      expect(view.status).toBe("active");
    },
    720_000,
  );
});

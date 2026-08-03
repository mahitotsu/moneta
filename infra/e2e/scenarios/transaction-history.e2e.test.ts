// Covers docs/e2e-scenarios.md A9.
import { fetchStackOutputs } from "../../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";

describe("A9: 取引履歴は新しい順に反映される", () => {
  it("開設・入金x2・出金の4件が新しい順で照会できる", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const accountId = await openFreshAccount(commandApi, queryApi, "0");

    // Fired back-to-back into the same MessageGroupId (=accountId): FIFO ordering means they're
    // applied in this order regardless of how close together they're sent (docs/adr/0002決定5).
    await commandApi.deposit(accountId, "30");
    await commandApi.deposit(accountId, "20");
    await commandApi.withdraw(accountId, "10");

    const history = await waitFor(
      async () => {
        const entries = await queryApi.getTransactionHistory(accountId);
        return entries.length >= 4 ? entries : undefined;
      },
      { description: `account ${accountId} transaction history to contain all 4 entries` },
    );

    expect(history.map((e) => e.type)).toEqual(["withdrawn", "deposited", "deposited", "opened"]);
    expect(history.map((e) => (e.amount === null ? null : Number(e.amount)))).toEqual([10, 20, 30, null]);

    const timestamps = history.map((e) => new Date(e.occurredAt).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }
  });
});

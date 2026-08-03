// Covers docs/e2e-scenarios.md F2 -- the transaction-history read model (AccountHistoryTable,
// docs/adr/0009) goes through the same outbox -> EventBridge -> DynamoDB path as the current-
// state view (docs/adr/0004), so it has the same ~90s convergence bound. Also confirms that
// querying before the new entry lands is a normal (shorter) response, not an error.
import { fetchStackOutputs } from "../../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";

describe("F2: 取引履歴も結果整合性の遅延窓を持つ", () => {
  it("入金直後の取引履歴は反映されないことがあるが、最大90秒以内に新しいエントリが現れる", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const accountId = await openFreshAccount(commandApi, queryApi, "0");

    const initialHistory = await queryApi.getTransactionHistory(accountId);
    expect(initialHistory.some((e) => e.type === "opened")).toBe(true);

    const depositResponse = await commandApi.deposit(accountId, "10");
    expect(depositResponse.status).toBe(202);

    const history = await waitFor(
      async () => {
        // A shorter (not-yet-updated) list is a normal intermediate state, not a failure --
        // querying it must keep succeeding throughout the wait (getTransactionHistory throws
        // on a non-200, so simply not throwing here already exercises that).
        const entries = await queryApi.getTransactionHistory(accountId);
        return entries.some((e) => e.type === "deposited" && Number(e.amount) === 10) ? entries : undefined;
      },
      { description: `account ${accountId} history to include the new deposit` },
    );

    expect(history.length).toBe(2);
  });
});

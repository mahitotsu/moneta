// Covers docs/e2e-scenarios.md A2/A4 (ATM入金/他行からの振込 -- same Deposit command, docs/
// adr/0009決定1) and A3/A5 (ATM出金/収納機関への支払い -- same Withdraw command). A4/A5's
// distinguishing feature (which screen the customer never sees, what display-only labels never
// reach the backend) is a Web UI concern, not observable over this HTTP-only harness -- see
// e2e/README.md for why browser-level coverage of A4/A5/H1-H3 is tracked separately.
// One chained test rather than two independent ones: A3's withdrawal is only meaningful against
// the balance A2's deposit already produced.
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";

describe("A2→A3: 入金・出金は最終的に残高へ反映される", () => {
  it("入金で残高が増え、続く出金で減る", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const accountId = await openFreshAccount(commandApi, queryApi, "100");

    const depositResponse = await commandApi.deposit(accountId, "50");
    expect(depositResponse.status).toBe(202);
    await waitFor(
      async () => {
        const view = await queryApi.getAccount(accountId);
        return view && Number(view.balance) === 150 ? view : undefined;
      },
      { description: `account ${accountId} balance to reach 150 after deposit` },
    );

    const withdrawResponse = await commandApi.withdraw(accountId, "30");
    expect(withdrawResponse.status).toBe(202);
    const afterWithdraw = await waitFor(
      async () => {
        const view = await queryApi.getAccount(accountId);
        return view && Number(view.balance) === 120 ? view : undefined;
      },
      { description: `account ${accountId} balance to reach 120 after withdrawal` },
    );

    expect(afterWithdraw.status).toBe("active");
  });
});

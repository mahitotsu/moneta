// Covers docs/e2e-scenarios.md B2, B7, A6 (deposit half already lived in B2, this adds the
// withdraw half of A6 to the same fixture at near-zero extra cost).
//
// Same rationale as domain-errors-active-account.e2e.test.ts: both assertions are rejections
// that leave state untouched, so they share one fixture frozen once in `beforeAll` instead of
// each paying its own open-wait + freeze-wait (~2x60-90s, docs/adr/0004).
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { settle } from "../support/poll";
import { openFreshAccount, waitForStatus } from "../support/testAccount";

describe("B(Frozen fixture共有): ドメインエラーは状態を動かさない", () => {
  let commandApi: ReturnType<typeof createCommandApi>;
  let queryApi: ReturnType<typeof createQueryApi>;
  let accountId: string;

  beforeAll(async () => {
    const outputs = await fetchStackOutputs();
    commandApi = createCommandApi(outputs.commandApiUrl);
    queryApi = createQueryApi(outputs.queryApiUrl);
    accountId = await openFreshAccount(commandApi, queryApi, "100");
    await commandApi.freeze(accountId, "CourtOrder");
    await waitForStatus(queryApi, accountId, "frozen");
  });

  it("B2: 凍結中の口座への入金は却下され、残高が変化しない", async () => {
    const response = await commandApi.deposit(accountId, "50");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "frozen" });
    expect(Number(after?.balance)).toBe(100);
  });

  it("A6: 凍結中の口座への出金も却下され、残高が変化しない", async () => {
    const response = await commandApi.withdraw(accountId, "50");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "frozen" });
    expect(Number(after?.balance)).toBe(100);
  });

  it("B7: 既にFrozenな口座への再Freezeは却下され、元のfrozenReasonが保持される", async () => {
    const response = await commandApi.freeze(accountId, "SuspectedFraud");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    // Setup fixed the reason to CourtOrder; a rejected re-freeze must not overwrite it.
    expect(after).toMatchObject({ status: "frozen", frozenReason: "court_order" });
  });
});

// Covers docs/e2e-scenarios.md FC4 (deposit half already lived in old B2, this adds the
// withdraw half of A6 to the same fixture at near-zero extra cost).
//
// Same rationale as domain-errors-active-account.e2e.test.ts: both assertions are rejections
// that leave state untouched, so they share one fixture frozen once in `beforeAll` instead of
// each paying its own open-wait + freeze-wait (~2x60-90s, docs/adr/0004).
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { settle } from "../support/poll";
import { openFreshAccount, waitForStatus } from "../support/testAccount";
import { signUpAndSignIn } from "../support/auth";

describe("B(Frozen fixture共有): ドメインエラーは状態を動かさない", () => {
  let commandApi: ReturnType<typeof createCommandApi>;
  let queryApi: ReturnType<typeof createQueryApi>;
  let accountId: string;

  beforeAll(async () => {
    const outputs = await fetchStackOutputs();
    // Freeze/再Freezeも口座を開いた識別子と同じでなければならない(docs/adr/0016決定3)。
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
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

// FC5(docs/decision-tables.md発見2の是正): Closeは却下ではなく実際に状態を動かす(Frozen->Closed)
// ため、上のBフィクスチャ(「ずっとfrozenのまま」という不変条件を前提に共有している)とは別に、
// 専用の口座を1つ開いて検証する(unfreeze-lifecycle.e2e.test.tsと同じ理由)。
describe("FC5(専用フィクスチャ): Frozenな口座は凍結解除を経由せず直接解約できる", () => {
  it("凍結中の口座をCloseすると、最終的にClosed・final_balanceを返す", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const accountId = await openFreshAccount(commandApi, queryApi, "100");
    await commandApi.freeze(accountId, "CourtOrder");
    await waitForStatus(queryApi, accountId, "frozen");

    const response = await commandApi.close(accountId);
    expect(response.status).toBe(202);

    await waitForStatus(queryApi, accountId, "closed");
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "closed" });
    expect(Number(after?.balance)).toBe(100);
  });
});

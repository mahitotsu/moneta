// Covers docs/e2e-scenarios.md B1, B5, B6, B8.
//
// All four assert a *rejection* that, by definition, leaves the account's state untouched
// (docs/adr/0002決定1). Since none of them is expected to succeed, they can safely share one
// fixture account opened once in `beforeAll` instead of each paying its own ~60-90s open-and-
// wait cost (docs/adr/0004's outbox-relay lag) -- the assertions don't depend on execution
// order or on each other, only on the fixture's balance staying at 100 throughout.
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { settle } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";

describe("B(Active fixture共有): ドメインエラーは状態を動かさない", () => {
  let commandApi: ReturnType<typeof createCommandApi>;
  let queryApi: ReturnType<typeof createQueryApi>;
  let accountId: string;

  beforeAll(async () => {
    const outputs = await fetchStackOutputs();
    commandApi = createCommandApi(outputs.commandApiUrl);
    queryApi = createQueryApi(outputs.queryApiUrl);
    accountId = await openFreshAccount(commandApi, queryApi, "100");
  });

  it("B1: 残高不足の出金は却下され、残高が変化しない", async () => {
    const response = await commandApi.withdraw(accountId, "1000000");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "active" });
    expect(Number(after?.balance)).toBe(100);
  });

  it("B5: 既にOpen済みの口座IDへの再Openは却下され、元の残高が保持される", async () => {
    const response = await commandApi.openAccount(accountId, "999999");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "active" });
    expect(Number(after?.balance)).toBe(100);
  });

  it("B6: 既にActiveな口座へのUnfreezeは却下され、状態・残高が変化しない", async () => {
    const response = await commandApi.unfreeze(accountId);
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "active" });
    expect(Number(after?.balance)).toBe(100);
  });

  it("B8: 負の金額での入金は却下され、残高が変化しない(APIGWの構造検証は正負を見ない, ADR-0006決定5)", async () => {
    const response = await commandApi.deposit(accountId, "-10");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "active" });
    expect(Number(after?.balance)).toBe(100);
  });
});

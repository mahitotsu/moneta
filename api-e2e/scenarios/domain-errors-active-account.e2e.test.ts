// Covers docs/e2e-scenarios.md FC3 (B1/B8相当), FC1 (B5相当), FC4 (B6相当).
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
import { signUpAndSignIn } from "../support/auth";

describe("FC(Active fixture共有): ドメインエラーは状態を動かさない", () => {
  let commandApi: ReturnType<typeof createCommandApi>;
  let queryApi: ReturnType<typeof createQueryApi>;
  let accountId: string;

  beforeAll(async () => {
    const outputs = await fetchStackOutputs();
    // このフィクスチャの口座を開いた同じ認証済み識別子を、以降の全アサーション
    // (再Open含む)で使い回す(docs/adr/0016決定3)。
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    accountId = await openFreshAccount(commandApi, queryApi, "100");
  });

  it("FC3(旧B1): 残高不足の出金は却下され、残高が変化しない", async () => {
    const response = await commandApi.withdraw(accountId, "1000000");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "active" });
    expect(Number(after?.balance)).toBe(100);
  });

  it("FC1(旧B5): 既にOpen済みの口座IDへの再Openは却下され、元の残高が保持される", async () => {
    const response = await commandApi.openAccount(accountId, "999999");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "active" });
    expect(Number(after?.balance)).toBe(100);
  });

  it("FC4(旧B6): 既にActiveな口座へのUnfreezeは却下され、状態・残高が変化しない", async () => {
    const response = await commandApi.unfreeze(accountId);
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "active" });
    expect(Number(after?.balance)).toBe(100);
  });

  it("FC2(旧B8): 負の金額での入金は却下され、残高が変化しない(APIGWの構造検証は正負を見ない, ADR-0006決定5)", async () => {
    const response = await commandApi.deposit(accountId, "-10");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "active" });
    expect(Number(after?.balance)).toBe(100);
  });

  // docs/decision-tables.md発見1の是正: Depositの負値(直上のテスト)には対があったのに、
  // Withdrawの負/ゼロ額は単体・E2Eとも一度も検証されていなかった非対称な穴。
  it("FC3(新規): 負またはゼロの金額での出金は却下され、残高が変化しない(APIGWの構造検証は正負を見ない, ADR-0006決定5)", async () => {
    const zero = await commandApi.withdraw(accountId, "0");
    expect(zero.status).toBe(202);
    const negative = await commandApi.withdraw(accountId, "-10");
    expect(negative.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "active" });
    expect(Number(after?.balance)).toBe(100);
  });
});

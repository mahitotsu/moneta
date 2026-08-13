// Covers docs/e2e-scenarios.md FC5 (旧B3/A8). Closed is terminal, so -- like the frozen fixture --
// both rejection assertions here (withdraw, deposit) share one fixture closed once in
// `beforeAll`.
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { settle } from "../support/poll";
import { openFreshAccount, waitForStatus } from "../support/testAccount";
import { signUpAndSignIn } from "../support/auth";

describe("B3/A8(Closed fixture共有): 解約済み口座への操作は却下され、残高・状態が変化しない", () => {
  let commandApi: ReturnType<typeof createCommandApi>;
  let queryApi: ReturnType<typeof createQueryApi>;
  let accountId: string;

  beforeAll(async () => {
    const outputs = await fetchStackOutputs();
    // Closeも同じ識別子で行う必要がある(docs/adr/0016決定3のownership検証)。
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    accountId = await openFreshAccount(commandApi, queryApi, "100");
    await commandApi.close(accountId);
    await waitForStatus(queryApi, accountId, "closed");
  });

  it("B3: 解約済み口座への出金は却下される", async () => {
    const response = await commandApi.withdraw(accountId, "10");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "closed" });
    expect(Number(after?.balance)).toBe(100);
  });

  it("A8: 解約済み口座への入金も却下される", async () => {
    const response = await commandApi.deposit(accountId, "10");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toMatchObject({ status: "closed" });
    expect(Number(after?.balance)).toBe(100);
  });
});

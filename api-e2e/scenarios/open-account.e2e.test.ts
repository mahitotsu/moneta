// Covers docs/e2e-scenarios.md FC1 (旧A1).
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { waitForStatus } from "../support/testAccount";
import { signUpAndSignIn } from "../support/auth";

describe("A1: 口座開設", () => {
  it("PUTで開設した口座は、最終的にActiveとして指定の初期残高で照会できる", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const accountId = crypto.randomUUID();

    const response = await commandApi.openAccount(accountId, "1000");
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ accountId, status: "accepted" });

    const view = await waitForStatus(queryApi, accountId, "active");
    expect(Number(view.balance)).toBe(1000);
    expect(view.frozenReason).toBeNull();
    expect(view.closedAt).toBeNull();
  });
});

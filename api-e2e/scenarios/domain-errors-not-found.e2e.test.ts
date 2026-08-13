// Covers docs/e2e-scenarios.md FC1 (旧B4). No fixture needed at all -- the account is never opened --
// so this is the cheapest domain-error scenario (a single settle() wait, no eventual-
// consistency polling).
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { settle } from "../support/poll";
import { signUpAndSignIn } from "../support/auth";

describe("B4: 存在しない口座への操作は却下される", () => {
  it("存在しない口座への入金は却下され、口座は作られない", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const accountId = crypto.randomUUID();

    const response = await commandApi.deposit(accountId, "10");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toBeNull();
  });
});

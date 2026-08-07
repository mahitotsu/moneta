// Covers docs/e2e-scenarios.md B4. No fixture needed at all -- the account is never opened --
// so this is the cheapest domain-error scenario (a single settle() wait, no eventual-
// consistency polling).
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { settle } from "../support/poll";

describe("B4: 存在しない口座への操作は却下される", () => {
  it("存在しない口座への入金は却下され、口座は作られない", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const accountId = crypto.randomUUID();

    const response = await commandApi.deposit(accountId, "10");
    expect(response.status).toBe(202);

    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(after).toBeNull();
  });
});

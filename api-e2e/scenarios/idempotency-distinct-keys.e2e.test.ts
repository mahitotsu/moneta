// Covers docs/e2e-scenarios.md E1 (旧C3) -- the counterpart to the same-key case (idempotency.e2e.test.ts): dedup is
// keyed on the Idempotency-Key itself, not on the command's content, so the same command body
// sent under two distinct keys must both apply.
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";
import { signUpAndSignIn } from "../support/auth";

describe("C3: 異なるIdempotency-Keyでの同内容コマンドは両方とも適用される", () => {
  it("同じ入金内容を異なるキーで2回送ると、2回分反映される", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const accountId = await openFreshAccount(commandApi, queryApi, "100");

    const first = await commandApi.deposit(accountId, "20", crypto.randomUUID());
    const second = await commandApi.deposit(accountId, "20", crypto.randomUUID());
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const view = await waitFor(
      async () => {
        const v = await queryApi.getAccount(accountId);
        return v && Number(v.balance) === 140 ? v : undefined;
      },
      { description: `account ${accountId} balance to reflect both deposits (140)` },
    );
    expect(view.status).toBe("active");
  });
});

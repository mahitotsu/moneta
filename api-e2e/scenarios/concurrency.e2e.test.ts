// Covers docs/e2e-scenarios.md R1 (旧D1) -- the PoC's central technical claim: same-account
// commands are serialized via MessageGroupId (docs/adr/0002). This proves FIFO ordering keeps
// the balance correct under concurrent writes; it does NOT exercise the in-Lambda OCC retry
// branch (see R2 in docs/e2e-scenarios.md for why that's a separate, still-unproven claim).
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { settle, waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";
import { signUpAndSignIn } from "../support/auth";

describe("D1: 同一口座への同時コマンドは直列化され、残高は不変条件を保つ", () => {
  it("合計が残高を超える2件の同時出金は、片方だけ成功し残高が負にならない", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const accountId = await openFreshAccount(commandApi, queryApi, "100");

    // Two independent customer actions (distinct Idempotency-Keys), each individually payable
    // (80 <= 100) but not both at once (160 > 100) -- forces exactly one to be rejected by
    // whichever is processed second under the account's serialized MessageGroupId.
    const [first, second] = await Promise.all([
      commandApi.withdraw(accountId, "80"),
      commandApi.withdraw(accountId, "80"),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const changed = await waitFor(
      async () => {
        const view = await queryApi.getAccount(accountId);
        return view && Number(view.balance) !== 100 ? Number(view.balance) : undefined;
      },
      { description: `account ${accountId} balance to move away from 100 after concurrent withdrawals` },
    );
    // Never -60 (both applied) and never negative -- the core invariant this scenario exists
    // to protect.
    expect(changed).toBe(20);

    for (let i = 0; i < 3; i++) {
      await settle(5_000);
      const view = await queryApi.getAccount(accountId);
      expect(Number(view?.balance)).toBe(20);
    }
  });
});

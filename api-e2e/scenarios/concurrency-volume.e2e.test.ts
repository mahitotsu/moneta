// Covers docs/e2e-scenarios.md R1 (旧D2) -- a higher-volume variant of concurrency.e2e.test.ts:
// with every concurrent write individually payable, none should be rejected. This proves FIFO
// ordering keeps the balance correct at 10x volume; it does NOT exercise the in-Lambda OCC
// retry branch (see R2 in docs/e2e-scenarios.md).
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { settle, waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";
import { signUpAndSignIn } from "../support/auth";

const CONCURRENT_DEPOSITS = 10;
const DEPOSIT_AMOUNT = 10;

describe("D2: 高頻度の同時書き込みでも取りこぼしがない", () => {
  it(`同一口座への${CONCURRENT_DEPOSITS}件の同時入金が、全件反映される`, async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const accountId = await openFreshAccount(commandApi, queryApi, "1000");

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_DEPOSITS }, () => commandApi.deposit(accountId, String(DEPOSIT_AMOUNT))),
    );
    for (const response of responses) {
      expect(response.status).toBe(202);
    }

    const expectedBalance = 1000 + CONCURRENT_DEPOSITS * DEPOSIT_AMOUNT;
    await waitFor(
      async () => {
        const view = await queryApi.getAccount(accountId);
        return view && Number(view.balance) === expectedBalance ? view : undefined;
      },
      { description: `account ${accountId} balance to reach ${expectedBalance} after ${CONCURRENT_DEPOSITS} concurrent deposits` },
    );

    // Guard against a delayed duplicate/lost update surfacing after the first observation.
    await settle(5_000);
    const after = await queryApi.getAccount(accountId);
    expect(Number(after?.balance)).toBe(expectedBalance);
  });
});

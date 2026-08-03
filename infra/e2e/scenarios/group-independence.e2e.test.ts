// Covers docs/e2e-scenarios.md E1 -- a malformed accountId is a genuine *infra* failure
// (persistence.rs's serde_json::from_str fails, not a DomainError, docs/adr/0006's known gap),
// so unlike DomainError it IS retried by SQS and can occupy its own MessageGroupId for a while.
// This approximates true head-of-line blocking (hard to force reliably without fault injection,
// docs/e2e-scenarios.md I1) by checking that an unrelated, healthy account's group is
// unaffected while a different group is busy retrying (docs/adr/0002決定3).
import { fetchStackOutputs } from "../../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";

describe("E1: 無関係な口座は互いに影響しない", () => {
  it("不正なaccountIdへの操作が持続的に失敗していても、別口座への入金は通常通り反映される", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);

    // Fire-and-forget: this accountId is not a UUID, so persistence.rs's deserialization fails
    // for every delivery attempt -- an infra failure that SQS retries into its own group,
    // independent of any other account's MessageGroupId.
    void commandApi.deposit("not-a-valid-account-id", "10");

    const accountId = await openFreshAccount(commandApi, queryApi, "0");
    const depositResponse = await commandApi.deposit(accountId, "10");
    expect(depositResponse.status).toBe(202);

    const view = await waitFor(
      async () => {
        const v = await queryApi.getAccount(accountId);
        return v && Number(v.balance) === 10 ? v : undefined;
      },
      { description: `account ${accountId} balance to reach 10 despite the unrelated failing group` },
    );
    expect(view.status).toBe("active");
  });
});

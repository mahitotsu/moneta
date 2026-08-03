// Covers docs/e2e-scenarios.md C1/C2.
import { fetchStackOutputs } from "../../support/stackOutputs";
import { createCommandApi, createQueryApi, rawRequest } from "../support/httpClient";
import { settle, waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";

describe("C: 冪等性・重複配信", () => {
  it("C1: 同一Idempotency-Keyでの同一コマンド再送は二重適用されない", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const accountId = await openFreshAccount(commandApi, queryApi, "100");
    const idempotencyKey = crypto.randomUUID();

    const first = await commandApi.deposit(accountId, "50", idempotencyKey);
    const second = await commandApi.deposit(accountId, "50", idempotencyKey);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const view = await waitFor(
      async () => {
        const v = await queryApi.getAccount(accountId);
        return v && Number(v.balance) !== 100 ? v : undefined;
      },
      { description: `account ${accountId} balance to move away from 100` },
    );
    expect(Number(view.balance)).toBe(150);

    // Guard against a *delayed* duplicate application arriving after the first observation.
    await settle();
    const after = await queryApi.getAccount(accountId);
    expect(Number(after?.balance)).toBe(150);
  });

  it("C2: Idempotency-Keyヘッダー欠落はAPIGWレベルで拒否される(SQSまで到達しない)", async () => {
    const outputs = await fetchStackOutputs();
    const accountId = crypto.randomUUID();

    const response = await rawRequest(`${outputs.commandApiUrl}/accounts/${accountId}/deposits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "10" }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

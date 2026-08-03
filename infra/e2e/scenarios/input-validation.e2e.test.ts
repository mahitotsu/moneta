// Covers docs/e2e-scenarios.md G1/G2/G3. Unlike category B/C/D/F, these are synchronous:
// API Gateway's Request Validator rejects before the message ever reaches SQS (docs/adr/0002's
// "structural validation only" boundary, docs/adr/0006決定4), so there is nothing to poll for.
import { fetchStackOutputs } from "../../support/stackOutputs";
import { createCommandApi, rawRequest } from "../support/httpClient";

describe("G: 入力検証(APIGWレベル、SQSに到達する前に拒否される)", () => {
  it("G1: 金額が数値文字列パターン外だと4xxで拒否される", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const accountId = crypto.randomUUID();

    const response = await commandApi.deposit(accountId, "abc");

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it("G2: 必須項目(initial_balance)欠落だと4xxで拒否される", async () => {
    const outputs = await fetchStackOutputs();
    const accountId = crypto.randomUUID();

    const response = await rawRequest(`${outputs.commandApiUrl}/accounts/${accountId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({}),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it("G3: 未知のFreezeReason値だと4xxで拒否される(FreezeCommandModelがenum制約を持つ, infra/lib/account-pipeline-stack.ts)", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const accountId = crypto.randomUUID();

    const response = await commandApi.freeze(accountId, "BogusReason" as never);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

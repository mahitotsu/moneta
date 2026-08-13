// Covers docs/e2e-scenarios.md FC7 (旧G1/G2/G3). Unlike most other scenarios, these are synchronous:
// API Gateway's Request Validator rejects before the message ever reaches SQS (docs/adr/0002's
// "structural validation only" boundary, docs/adr/0006決定4), so there is nothing to poll for.
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, rawRequest } from "../support/httpClient";
import { signUpAndSignIn } from "../support/auth";

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
    // Open(PUT)は認証必須(docs/adr/0016決定2)。Cognito Authorizerはリクエスト検証より先に
    // 評価される(AWSのREST APIの評価順)ため、有効なトークンが無いとこの検証自体を試す前に
    // 401で拒否されてしまう——ここで確かめたいのはボディの構造検証であり認証ではないため、
    // 有効なトークンを付ける。
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const accountId = crypto.randomUUID();

    const response = await rawRequest(`${outputs.commandApiUrl}/accounts/${accountId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${identity.idToken}`,
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it("G3: 未知のFreezeReason値だと4xxで拒否される(FreezeCommandModelがenum制約を持つ, infra/lib/account-pipeline-stack.ts)", async () => {
    const outputs = await fetchStackOutputs();
    // Freezeも認証必須(docs/adr/0016決定2)——G2と同じ理由でトークンを付ける。
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const accountId = crypto.randomUUID();

    const response = await commandApi.freeze(accountId, "BogusReason" as never);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

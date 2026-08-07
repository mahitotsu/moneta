// Covers docs/e2e-scenarios.md G4 -- locks in a documented, deliberately-accepted gap (docs/
// adr/0006's "今回のスコープ外として残す既知のギャップ"): a malformed accountId still gets a
// 202 Accepted (the Lambda-less integration can't validate it), but persistence.rs's
// deserialization fails deterministically on every delivery, which is classified as an infra
// failure (not a DomainError) and therefore retried until it lands in the FIFO DLQ
// (MAX_RECEIVE_COUNT=3, infra/lib/account-pipeline-stack.ts). This is not a bug to fix; it's a
// regression test that the gap hasn't silently changed shape (e.g. started succeeding, or
// started being misclassified as a DomainError and silently dropped instead of retried).
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi } from "../support/httpClient";
import { waitForMatchingMessage } from "../support/dlq";

describe("G4: 不正な形式のaccountIdは202を返しつつ、最終的にDLQへ到達する", () => {
  it(
    "既知のギャップ: クライアントには202が返るが、実際には反映されずDLQ行きになる",
    async () => {
      const outputs = await fetchStackOutputs();
      const commandApi = createCommandApi(outputs.commandApiUrl);
      const accountId = `not-a-valid-uuid-${crypto.randomUUID()}`;

      const response = await commandApi.deposit(accountId, "10");
      expect(response.status).toBe(202);

      await waitForMatchingMessage(outputs.deadLetterQueueUrl, (body) => body.includes(accountId));
    },
    300_000,
  );
});

// Covers docs/e2e-scenarios.md FC10 (旧J1/J7) as a real browser journey (docs/adr/0014) -- the deployed
// web-ui, not just the HTTP contract api-e2e/scenarios/transfer-furikae.e2e.test.ts already
// verifies. Same-owner (振替) transfers require no confirmation step, so this is the shortest
// full round trip: sign in -> 送金タブ -> 振替フォーム -> 完了 badge.
import { test } from "@playwright/test";
import { fetchStackOutputs } from "../support/stackOutputs";
import { openFreshAccount } from "../support/seed";
import { seedCustomerSession } from "../support/session";
import { expectKindLabel, expectStateBadge, goToTransfersTab, startFurikae } from "../support/ui";

test("J1/J7: 振替は確認不要で即座に開始され、UI上で完了まで反映される", async ({ page, context }) => {
  const outputs = await fetchStackOutputs();
  const customerName = `ui-e2e-furikae-${crypto.randomUUID().slice(0, 8)}`;
  const fromId = await openFreshAccount(outputs, customerName, "1000.00");
  const toId = await openFreshAccount(outputs, customerName, "0.00");

  await seedCustomerSession(context, customerName, [{ accountId: fromId }, { accountId: toId }]);
  await page.goto(outputs.webUiUrl);

  await goToTransfersTab(page);
  await startFurikae(page, { fromAccountId: fromId, toAccountId: toId, amount: "300.00" });

  await expectKindLabel(page, "振替");
  await expectStateBadge(page, "完了");
});

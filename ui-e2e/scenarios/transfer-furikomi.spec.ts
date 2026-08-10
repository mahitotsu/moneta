// Covers docs/e2e-scenarios.md FC11 (旧J5/J6) as a real browser journey (docs/adr/0014): different-owner
// (振込) transfers stop at pending_confirmation and must render the 確認/取消 buttons before
// anything is debited -- api-e2e/scenarios/transfer-furikomi.e2e.test.ts already proves this at
// the HTTP layer, this proves the UI actually shows the right screen and the button actually
// drives Confirm.
import { test } from "@playwright/test";
import { fetchStackOutputs } from "../support/stackOutputs";
import { openFreshAccount } from "../support/seed";
import { waitForOwnerIndexed } from "../support/ownerIndex";
import { seedCustomerSession } from "../support/session";
import { clickCancelTransfer, clickConfirmTransfer, expectStateBadge, goToTransfersTab, startFurikomi } from "../support/ui";

function distinctOwners(): [string, string] {
  const suffix = crypto.randomUUID().slice(0, 8);
  return [`ui-e2e-furikomi-a-${suffix}`, `ui-e2e-furikomi-b-${suffix}`];
}

test("J5/J6: 振込はpending_confirmationで停止し、確認すると完了する", async ({ page, context }) => {
  const outputs = await fetchStackOutputs();
  const [ownerA, ownerB] = distinctOwners();
  const fromId = await openFreshAccount(outputs, ownerA, "1000.00");
  const toId = await openFreshAccount(outputs, ownerB, "0.00");
  await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
  await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

  // 振込の送金先は自分の口座一覧ではなく手入力(TransferForm.tsx)なので、seedするのは
  // 送金元(ownerA名義)だけでよい。
  await seedCustomerSession(context, ownerA, [{ accountId: fromId }]);
  await page.goto(outputs.webUiUrl);

  await goToTransfersTab(page);
  await startFurikomi(page, { fromAccountId: fromId, toAccountId: toId, amount: "300.00" });

  await expectStateBadge(page, "確認待ち");
  await clickConfirmTransfer(page);
  await expectStateBadge(page, "完了");
});

test("振込は確認前に取消すとcancelledになる", async ({ page, context }) => {
  const outputs = await fetchStackOutputs();
  const [ownerA, ownerB] = distinctOwners();
  const fromId = await openFreshAccount(outputs, ownerA, "1000.00");
  const toId = await openFreshAccount(outputs, ownerB, "0.00");
  await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
  await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

  await seedCustomerSession(context, ownerA, [{ accountId: fromId }]);
  await page.goto(outputs.webUiUrl);

  await goToTransfersTab(page);
  await startFurikomi(page, { fromAccountId: fromId, toAccountId: toId, amount: "300.00" });

  await expectStateBadge(page, "確認待ち");
  await clickCancelTransfer(page);
  await expectStateBadge(page, "取消済み");
});

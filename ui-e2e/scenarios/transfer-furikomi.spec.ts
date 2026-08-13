// Covers docs/e2e-scenarios.md FC11 (旧J5/J6) as a real browser journey (docs/adr/0014): different-owner
// (振込) transfers stop at pending_confirmation and must render the 確認/取消 buttons before
// anything is debited -- api-e2e/scenarios/transfer-furikomi.e2e.test.ts already proves this at
// the HTTP layer, this proves the UI actually shows the right screen and the button actually
// drives Confirm.
import { test } from "@playwright/test";
import { fetchStackOutputs } from "../support/stackOutputs";
import { openFreshAccount } from "../support/seed";
import { waitForOwnerIndexed } from "../support/ownerIndex";
import { waitForAccountNumber } from "../support/accountNumber";
import { signUpAndSignIn, type TestIdentity } from "../support/auth";
import { seedAuthSession } from "../support/session";
import { clickCancelTransfer, clickConfirmTransfer, expectStateBadge, goToTransfersTab, startFurikomi } from "../support/ui";

async function distinctIdentities(userPoolClientId: string): Promise<[TestIdentity, TestIdentity]> {
  return [await signUpAndSignIn(userPoolClientId), await signUpAndSignIn(userPoolClientId)];
}

test("J5/J6: 振込はpending_confirmationで停止し、確認すると完了する", async ({ page, context }) => {
  const outputs = await fetchStackOutputs();
  const [identityA, identityB] = await distinctIdentities(outputs.userPoolClientId);
  const fromId = await openFreshAccount(outputs, identityA.idToken, "1000.00");
  const toId = await openFreshAccount(outputs, identityB.idToken, "0.00");
  await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
  await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);
  const toNumber = await waitForAccountNumber(outputs, toId, identityA.idToken);

  // 振込の送金先は自分の口座一覧ではなく支店+口座番号の検索(TransferForm.tsx、docs/adr/0015)
  // なので、ブラウザにサインインさせるのは送金元(identityA)だけでよい。
  await seedAuthSession(context, identityA);
  await page.goto(outputs.webUiUrl);

  await goToTransfersTab(page);
  await startFurikomi(page, {
    fromAccountId: fromId,
    branchCode: toNumber.branchCode,
    accountNumber: toNumber.accountNumber,
    amount: "300.00",
  });

  await expectStateBadge(page, "確認待ち");
  await clickConfirmTransfer(page);
  await expectStateBadge(page, "完了");
});

test("振込は確認前に取消すとcancelledになる", async ({ page, context }) => {
  const outputs = await fetchStackOutputs();
  const [identityA, identityB] = await distinctIdentities(outputs.userPoolClientId);
  const fromId = await openFreshAccount(outputs, identityA.idToken, "1000.00");
  const toId = await openFreshAccount(outputs, identityB.idToken, "0.00");
  await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
  await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);
  const toNumber = await waitForAccountNumber(outputs, toId, identityA.idToken);

  await seedAuthSession(context, identityA);
  await page.goto(outputs.webUiUrl);

  await goToTransfersTab(page);
  await startFurikomi(page, {
    fromAccountId: fromId,
    branchCode: toNumber.branchCode,
    accountNumber: toNumber.accountNumber,
    amount: "300.00",
  });

  await expectStateBadge(page, "確認待ち");
  await clickCancelTransfer(page);
  await expectStateBadge(page, "取消済み");
});

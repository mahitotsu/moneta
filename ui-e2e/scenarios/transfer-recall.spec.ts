// Covers docs/e2e-scenarios.md FC12 (旧J9) as a real browser journey (docs/adr/0014): the 組戻す button
// is the one control that only ever appears after a full furikomi round trip (credited, within
// the 24h window -- crates/transfer-service/src/saga.rs's RECALL_WINDOW), so it's the UI feature
// this whole harness exists to close the gap on (see the conversation that led to docs/adr/0014).
import { test } from "@playwright/test";
import { fetchStackOutputs } from "../support/stackOutputs";
import { openFreshAccount } from "../support/seed";
import { waitForOwnerIndexed } from "../support/ownerIndex";
import { waitForAccountNumber } from "../support/accountNumber";
import { signUpAndSignIn } from "../support/auth";
import { seedAuthSession } from "../support/session";
import {
  clickConfirmTransfer,
  clickRecall,
  expectKindLabel,
  expectStateBadge,
  goToTransfersTab,
  startFurikomi,
} from "../support/ui";

test("J9: creditedになった振込は組戻すボタンで組戻され、新しい送金として完了する", async ({ page, context }) => {
  const outputs = await fetchStackOutputs();
  const identityA = await signUpAndSignIn(outputs.userPoolClientId);
  const identityB = await signUpAndSignIn(outputs.userPoolClientId);
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
  await clickConfirmTransfer(page);
  await expectStateBadge(page, "完了");

  // updated_atはたった今なので、24時間の時間窓(表示上のヒント、docs/adr/0012決定6)の内側。
  await clickRecall(page);

  // クリック後は新しいtransferId(組戻し自身のサガ)の詳細画面に切り替わる
  // (TransferDetailScreen.tsxのonRecalled)。
  await expectKindLabel(page, "組戻し");
  await expectStateBadge(page, "完了");
});

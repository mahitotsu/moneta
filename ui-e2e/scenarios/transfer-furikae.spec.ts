// Covers docs/e2e-scenarios.md FC10 (旧J1/J7) as a real browser journey (docs/adr/0014) -- the deployed
// web-ui, not just the HTTP contract api-e2e/scenarios/transfer-furikae.e2e.test.ts already
// verifies. Same-owner (振替) transfers require no confirmation step, so this is the shortest
// full round trip: sign in -> 送金タブ -> 振替フォーム -> 完了 badge.
import { test, expect } from "../support/fixtures";
import { fetchStackOutputs } from "../support/stackOutputs";
import { openFreshAccount } from "../support/seed";
import { signUpAndSignIn } from "../support/auth";
import { seedAuthSession } from "../support/session";
import {
  expectKindLabel,
  expectPendingPlaceholder,
  expectStateBadge,
  goBackFromDetail,
  goToTransfersTab,
  startFurikae,
} from "../support/ui";

test("J1/J7: 振替は確認不要で即座に開始され、UI上で完了まで反映される", async ({ page, context }) => {
  const outputs = await fetchStackOutputs();
  const identity = await signUpAndSignIn(outputs.userPoolClientId);
  const fromId = await openFreshAccount(outputs, identity.idToken, "1000.00");
  const toId = await openFreshAccount(outputs, identity.idToken, "0.00");

  await seedAuthSession(context, identity);
  await page.goto(outputs.webUiUrl);

  await goToTransfersTab(page);
  await startFurikae(page, { fromAccountId: fromId, toAccountId: toId, amount: "300.00" });

  await expectKindLabel(page, "振替");
  await expectStateBadge(page, "完了");

  // FC15(docs/decision-tables.mdの議論で判明): saga.rsのrecall_eligibilityがkind===Furikomi
  // でなければ却下する業務ルールを、TransferDetailScreen.tsx:155は「組戻す」ボタン自体を
  // 描画しないという形でも(バックエンドの拒否とは別に)実装している。api-e2eのFC15は
  // APIを直接叩いてサーバー側の拒否のみを検証しており、このUI固有の主張(振替の完了画面には
  // 組戻すボタンがそもそも現れない)は一度も検証されていなかった。
  await expect(page.getByRole("button", { name: "組戻す" })).not.toBeVisible();

  // FC19(docs/adr/0017): 送金一覧はもうlocalStorageではなくサーバー側投影
  // (CustomerTransfersTable)から取得する。一覧に戻ったときに、たった今完了させた送金が
  // 実際に(手動でローカルへ記録するような処理を挟まず)自動的に現れることを確認する。
  await goBackFromDetail(page);
  await expect(page.locator(".account-card-name", { hasText: "振替" })).toBeVisible({ timeout: 30_000 });
});

// FC13(docs/decision-tables.mdの議論で判明): TransferForm.tsxのcanSubmit(TransferForm.tsx:53)は
// 金額を一切検証しておらず、金額欄にも`min`等のHTML制約がない。つまり実際の顧客が"0"を入力して
// 送信ボタンを押す、という操作はUI上で現実に可能である。しかもStartコマンドはSQS投入のみで
// 202を返すため(command_intake.rsのStartError::NonPositiveAmountは非同期に却下され、呼び出し元
// には何も返らない)、フォームのmutationは「成功」してTransferDetailScreenへ遷移する。サガは
// 一度も作られないため、この画面は「反映待ち」のプレースホルダーのまま(ADR-0012決定6が明記する、
// 結果整合性のラグと真に存在しないIDを区別しないという方針)——エラーメッセージが出るわけではない。
// 当初は「エラーが正しく表示されるか」を検証するつもりだったが、実際の挙動を確認した結果、
// 検証すべきは「クラッシュしたり空白のまま止まったりせず、既存のUX方針通り反映待ち表示になる」
// ことだと判明した。
test("FC13: 非正の金額を送信すると、サガが一度も作られないため反映待ち画面のまま留まる", async ({ page, context }) => {
  const outputs = await fetchStackOutputs();
  const identity = await signUpAndSignIn(outputs.userPoolClientId);
  const fromId = await openFreshAccount(outputs, identity.idToken, "1000.00");
  const toId = await openFreshAccount(outputs, identity.idToken, "0.00");

  await seedAuthSession(context, identity);
  await page.goto(outputs.webUiUrl);

  await goToTransfersTab(page);
  await startFurikae(page, { fromAccountId: fromId, toAccountId: toId, amount: "0" });

  await expectPendingPlaceholder(page);
  // 正常な送金は数十秒程度でcredited/pending_confirmationへ遷移する(他specの実測で9〜15秒)。
  // ここでは「エラーも出ないが、いつまでも反映されない」ことの下限確認として、それより十分
  // 長く待っても状態が変わらないことを確認する(「絶対に変わらない」ことの証明ではない)。
  await page.waitForTimeout(20_000);
  await expectPendingPlaceholder(page);
});

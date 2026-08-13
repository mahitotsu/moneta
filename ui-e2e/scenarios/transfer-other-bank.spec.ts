// Covers docs/e2e-scenarios.md FC17 (docs/adr/0015決定7): 振込の導線に追加した自行/他行の
// 分岐のうち、他行あては非機能なプレースホルダであり、選んでもTransferForm(≒バックエンド
// 呼び出し)は一切出ないことを実ブラウザで確認する。TransferListScreen.test.tsx(Vitest)が
// 同じ主張をモックAPIで既に検証しているが、あちらは「実際にAPI呼び出しが発生していないこと」
// までは見ていない——ここでは実デプロイ環境に対して、クリック後もネットワークが動かず案内文
// だけが表示されることを確認する。
import { test, expect } from "@playwright/test";
import { fetchStackOutputs } from "../support/stackOutputs";
import { openFreshAccount } from "../support/seed";
import { signUpAndSignIn } from "../support/auth";
import { seedAuthSession } from "../support/session";
import { goToTransfersTab } from "../support/ui";

test("FC17: 振込(他行あて)は選んでもサポート外の案内のみで、フォームは出ない", async ({ page, context }) => {
  const outputs = await fetchStackOutputs();
  const identity = await signUpAndSignIn(outputs.userPoolClientId);
  // TransferListScreen.tsxは自分の口座が1つもない間、振替/振込/振込(他行あて)のボタン自体を
  // 描画しない(「送金を行うには、まず口座を開設してください」の分岐)。この画面に到達するには
  // 口座が最低1つ要る——口座IDそのものはこのspecでは使わない。
  await openFreshAccount(outputs, identity.idToken, "1000.00");

  await seedAuthSession(context, identity);
  await page.goto(outputs.webUiUrl);

  await goToTransfersTab(page);

  let apiRequested = false;
  page.on("request", (request) => {
    if (/-query-api|-command-api/.test(new URL(request.url()).pathname)) {
      apiRequested = true;
    }
  });

  await page.getByRole("button", { name: "振込(他行あて)" }).click();

  await expect(page.getByText("他行あての振込は現在サポートしておりません。今後の検証テーマです。")).toBeVisible();
  await expect(page.getByLabel("送金先の支店")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "振込を依頼する" })).not.toBeVisible();

  // クリック直後の同期的なレンダリングを見ればよく、非同期のポーリングと競合しないよう
  // ネットワーク監視は短時間に留める(既存の残高ポーリング等が別途動いているため)。
  await page.waitForTimeout(1_000);
  expect(apiRequested).toBe(false);
});

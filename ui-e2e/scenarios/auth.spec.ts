// Covers docs/e2e-scenarios.md FC18 (docs/adr/0016) as a real browser journey, mirroring
// api-e2e/scenarios/auth.e2e.test.ts's HTTP-level coverage of the same ADR but for the one thing
// an HTTP-only harness and mocked-API component tests (SignInForm.test.tsx/
// AccountListScreen.test.tsx) can't reach: the actual サインイン画面の DOM/event-handler wiring
// against the live Cognito User Pool + deployed backend (docs/adr/0014's stated purpose for
// ui-e2e/). Unlike the other scenarios/*.spec.ts files, this one deliberately does NOT use
// support/session.ts's seedAuthSession -- bypassing the sign-in screen is exactly what those
// specs want (their subject is the transfer screens), but here the sign-up/sign-in screen itself
// is the subject.
import { test, expect } from "../support/fixtures";
import { fetchStackOutputs } from "../support/stackOutputs";
import { registerAccessTokenForCleanup } from "../support/auth";
import { goToTransfersTab } from "../support/ui";

test("FC18: サインアップ→ログインした本人の口座一覧に、開設した口座が自動的に現れる", async ({ page }) => {
  const outputs = await fetchStackOutputs();
  const username = `ui-e2e-signup-${crypto.randomUUID().slice(0, 8)}`;
  const password = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  await page.goto(outputs.webUiUrl);

  // 初期表示はログインタブ。新規登録タブへ切り替える。
  await page.getByRole("button", { name: "新規登録", exact: true }).click();
  await page.getByLabel("ユーザー名").fill(username);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "登録してはじめる" }).click();

  // PreSignUpトリガーが自動確認するため確認コード入力は無く、登録直後にそのままサインイン
  // 済みの状態で口座一覧(空)へ遷移する(docs/adr/0016決定1、SignInForm.tsxのsignUpの実装)。
  await expect(page.getByText(`${username} 様`)).toBeVisible();
  await expect(page.getByText("まだ口座がありません。下から口座を開設してください。")).toBeVisible();

  // このユーザーはsupport/auth.tsのsignUpAndSignIn()を経由せず実際のサインイン画面から
  // 作られたため、cleanupSignedUpUsers()の自動追跡に乗らない——localStorageから直接
  // accessTokenを取り出し、他のテストと同じクリーンアップ待ち行列に加える
  // (2026-08-14発覚: このtest固有の漏れがあった)。
  const accessToken = await page.evaluate(() => localStorage.getItem("moneta.auth.accessToken"));
  if (accessToken) registerAccessTokenForCleanup(accessToken);

  // 「既存の口座をこの一覧に追加」という手入力フォームはもう存在しない(docs/adr/0016決定4、
  // 今回のセキュリティ修正の根本原因だった機能そのものの廃止)。
  await expect(page.getByPlaceholder("口座ID")).toHaveCount(0);

  // 口座を新規開設すると、サーバー側のCustomerAccountsTable(docs/adr/0016決定4)がイベント
  // 駆動で埋まり、GET /customers/me/accountsが自動的にそれを返すようになる——ローカル操作は
  // 一切不要。
  await page.getByRole("button", { name: "口座を追加" }).click();
  await page.getByLabel("初期残高").fill("500.00");
  await page.getByRole("button", { name: "開設", exact: true }).click();

  // customer-accounts-projectorの反映を待つ(結果整合性、docs/adr/0016決定4)——反映までは
  // 「まだ口座がありません」のままなので、空状態の消滅ではなく口座カードの出現そのものを待つ。
  await expect(page.locator(".account-card-name", { hasText: "普通預金" })).toBeVisible({ timeout: 30_000 });

  // ページを再読み込みしてもセッションが保たれる(idTokenがlocalStorageに残っている、
  // auth.tsのgetCurrentSession)。
  await page.reload();
  await expect(page.getByText(`${username} 様`)).toBeVisible();
  await expect(page.locator(".account-card-name", { hasText: "普通預金" })).toBeVisible({ timeout: 30_000 });

  // 送金タブへの遷移そのものが認証済みセッションで問題なく動くことも確認しておく(このspecの
  // 口座は1つだけなので、振替ボタンは「2つ以上必要」の理由で無効表示になる——TransferForm自体
  // の振る舞いはtransfer-*.spec.tsの担当)。
  await goToTransfersTab(page);
  await expect(page.getByRole("button", { name: "振替", exact: true })).toBeDisabled();

  // サインアウトすると再びサインイン画面に戻る。
  await page.getByRole("button", { name: "サインアウト" }).click();
  await expect(page.getByRole("button", { name: "ログインする" })).toBeVisible();
});

test("FC18: 認証情報が誤っているとログインに失敗し、業務的な文言のみが表示される", async ({ page }) => {
  const outputs = await fetchStackOutputs();

  await page.goto(outputs.webUiUrl);

  await page.getByLabel("ユーザー名").fill(`ui-e2e-no-such-user-${crypto.randomUUID().slice(0, 8)}`);
  await page.getByLabel("パスワード").fill("wrong-password-but-8-plus-chars");
  await page.getByRole("button", { name: "ログインする" }).click();

  // Cognitoの内部例外名(NotAuthorizedException等)を一切出さない(web-ui全体の方針、
  // SignInForm.tsxのfriendlyAuthErrorMessage)。
  await expect(page.getByText("ユーザー名またはパスワードが正しくありません。")).toBeVisible();
  await expect(page.getByText(/Exception/)).not.toBeVisible();
});

// support/auth.tsのsignUpAndSignIn()が作った使い捨てCognitoユーザーと、support/seed.tsが
// 開設した口座データを、ワーカーの終了時にまとめて削除するためのフィクスチャ。
// playwright.config.tsはfullyParallel: trueなので、ファイル単位でafterAll的なteardownを
// 書いても複数のテストが別ワーカーへ分散され得て信頼できない——Playwrightが保証する
// 「ワーカー終了時に必ず1回だけ走る」worker-scopedかつautoなフィクスチャのteardown
// (use()の後の処理)に乗せる。各specファイルはこのファイルから`test`/`expect`をimportする
// だけでよく、個々のテストコード側の変更は不要(2026-08-14発覚: この仕組みが無く、npm testを
// 回すたびにUser Poolと複数のDynamoDBテーブルへデータが際限なく積み上がっていた)。
import { test as base, expect } from "@playwright/test";
import { cleanupSignedUpUsers } from "./auth";
import { cleanupTestData } from "./testDataCleanup";
import { fetchStackOutputs } from "./stackOutputs";

export const test = base.extend<object, { cognitoCleanup: void }>({
  cognitoCleanup: [
    async ({}, use) => {
      await use();
      await cleanupSignedUpUsers();
      const outputs = await fetchStackOutputs();
      await cleanupTestData(outputs);
    },
    { scope: "worker", auto: true },
  ],
});

export { expect };

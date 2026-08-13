// support/auth.tsのsignUpAndSignIn()が作った使い捨てCognitoユーザーを、ワーカーの終了時に
// まとめて削除するためのフィクスチャ。playwright.config.tsはfullyParallel: trueなので、
// ファイル単位でafterAll的なteardownを書いても複数のテストが別ワーカーへ分散され得て
// 信頼できない——Playwrightが保証する「ワーカー終了時に必ず1回だけ走る」worker-scopedかつ
// autoなフィクスチャのteardown(use()の後の処理)に乗せる。各specファイルはこのファイルから
// `test`/`expect`をimportするだけでよく、個々のテストコード側の変更は不要
// (2026-08-14発覚: この仕組みが無く、npm testを回すたびにUser Poolにユーザーが際限なく
// 積み上がっていた)。
import { test as base, expect } from "@playwright/test";
import { cleanupSignedUpUsers } from "./auth";

export const test = base.extend<object, { cognitoCleanup: void }>({
  cognitoCleanup: [
    async ({}, use) => {
      await use();
      await cleanupSignedUpUsers();
    },
    { scope: "worker", auto: true },
  ],
});

export { expect };

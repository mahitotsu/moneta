// 各テストファイルの終了時に、そのファイル内でsignUpAndSignIn()した使い捨てCognitoユーザーを
// 全て削除する(support/auth.tsのcleanupSignedUpUsers)。個々のシナリオファイルにafterAllを
// 書かせず、jest.config.jsのsetupFilesAfterEnvで全ファイル共通に一度だけ登録する
// (2026-08-14発覚: このteardownが無かったため、npm testを回すたびにUser Poolにユーザーが
// 際限なく積み上がっていた)。
import { cleanupSignedUpUsers } from "./support/auth";

afterAll(async () => {
  await cleanupSignedUpUsers();
});

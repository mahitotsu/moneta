// 各テストファイルの終了時に、そのファイル内でsignUpAndSignIn()した使い捨てCognitoユーザーと、
// openAccount()/start()で作った口座・送金データを全て削除する(support/auth.tsの
// cleanupSignedUpUsers・support/testDataCleanup.tsのcleanupTestData)。個々のシナリオファイルに
// afterAllを書かせず、jest.config.jsのsetupFilesAfterEnvで全ファイル共通に一度だけ登録する
// (2026-08-14発覚: このteardownが無かったため、npm testを回すたびにUser Poolと複数の
// DynamoDBテーブルへデータが際限なく積み上がっていた)。
import { cleanupSignedUpUsers } from "./support/auth";
import { cleanupTestData } from "./support/testDataCleanup";
import { fetchStackOutputs } from "./support/stackOutputs";

afterAll(async () => {
  await cleanupSignedUpUsers();
  const outputs = await fetchStackOutputs();
  await cleanupTestData(outputs);
});

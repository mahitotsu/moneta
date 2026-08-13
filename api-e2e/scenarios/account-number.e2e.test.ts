// Covers docs/e2e-scenarios.md FC16 -- account-number-projector(docs/adr/0015)を、口座開設から
// 支店+口座番号の反映を待ち、その番号から口座を解決できるところまでHTTPレベルで検証する。
// owner_projector.rs(docs/adr/0011)と同じ「Openedだけを購読する専用の小さな投影」の新規版。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { createAccountNumberApi } from "../support/accountNumberClient";
import { waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";
import { signUpAndSignIn } from "../support/auth";

describe("FC16: 人間可読な口座番号(支店+7桁)からの宛先解決", () => {
  it(
    "口座開設後、支店+口座番号が反映され、その番号から同じ口座へ解決できる",
    async () => {
      const outputs = await fetchStackOutputs();
      // ownerIdはもはやリクエストボディの自己申告値ではなく、Cognito認証済み識別子のsub
      // (docs/adr/0016決定3)。以降のアサーションはこのsubと比較する。
      const identity = await signUpAndSignIn(outputs.userPoolClientId);
      const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
      const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
      const accountNumberApi = createAccountNumberApi(outputs.accountNumberQueryApiUrl, identity.idToken);
      const accountId = await openFreshAccount(commandApi, queryApi, "0");

      // account-number-projectorの反映を待つ(結果整合性、docs/adr/0015)。まだ反映されて
      // いない間はnullが返るのが正常であり、これ自体はエラーではない(docs/adr/0004の慣行)。
      // waitForは`undefined`だけを「未確定」とみなす(testAccount.tsのwaitForStatusと同じ
      // 変換規約)ため、nullをundefinedへ変換してから渡す。
      const byAccount = await waitFor(async () => (await accountNumberApi.lookupByAccountId(accountId)) ?? undefined, {
        description: `account ${accountId} to get a friendly account number`,
      });

      expect(byAccount.accountId).toBe(accountId);
      expect(byAccount.ownerId).toBe(identity.sub);
      expect(byAccount.accountNumber).toMatch(/^\d{7}$/);
      expect(byAccount.branchCode).toMatch(/^\d{3}$/);

      // 逆方向(口座番号→口座)。両方向が同じ内容へ解決することを確認する。
      const byNumber = await accountNumberApi.lookupByNumber(byAccount.accountNumber);
      expect(byNumber).toEqual(byAccount);

      // 支店は決定的に割り当てられる(docs/adr/0015決定4)——繰り返し読んでも変わらない。
      const byAccountAgain = await accountNumberApi.lookupByAccountId(accountId);
      expect(byAccountAgain?.branchCode).toBe(byAccount.branchCode);

      // 存在しない口座番号は404/nullになる。7桁の数字空間からの衝突は事実上無視できる
      // (このハーネス全体がUUIDの衝突を無視するのと同じ割り切り)。
      const notFound = await accountNumberApi.lookupByNumber("0000000");
      expect(notFound).toBeNull();
    },
    60_000,
  );
});

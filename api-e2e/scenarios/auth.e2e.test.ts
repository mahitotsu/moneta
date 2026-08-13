// Covers docs/e2e-scenarios.md FC18 (docs/adr/0016) -- Amazon Cognitoによる実認証そのもの。
// 他の全シナリオは「認証済みの1つ(または2つ)の識別子を使って既存の業務フローを検証する」
// という形で認証を前提にしているだけだが、このファイルは認証の仕組み自体を主張の対象にする:
// (1) セルフサインアップ+サインインしたばかりの新規識別子で口座開設でき、
//     `GET /customers/me/accounts`(新設、docs/adr/0016決定4)が自分の口座だけを返すこと、
// (2) 保護されたエンドポイントはAuthorizationヘッダーが無ければ401になること(決定2)、
// (3) Deposit/Withdraw(外部チャネル、ADR-0009決定1)は引き続き無認証で動くこと(決定2の例外)。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi, rawRequest } from "../support/httpClient";
import { waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";
import { signUpAndSignIn } from "../support/auth";

describe("FC18a: 新規サインアップ+サインインした識別子で口座を開設でき、自分の口座一覧に現れる", () => {
  it("GET /customers/me/accountsは自分が開設した口座だけを返し、他人の口座は含まない", async () => {
    const outputs = await fetchStackOutputs();
    const identityA = await signUpAndSignIn(outputs.userPoolClientId);
    const identityB = await signUpAndSignIn(outputs.userPoolClientId);

    const commandApiA = createCommandApi(outputs.commandApiUrl, identityA.idToken);
    const queryApiA = createQueryApi(outputs.queryApiUrl, identityA.idToken);
    const commandApiB = createCommandApi(outputs.commandApiUrl, identityB.idToken);
    const queryApiB = createQueryApi(outputs.queryApiUrl, identityB.idToken);

    const accountIdA = await openFreshAccount(commandApiA, queryApiA, "1000");
    const accountIdB = await openFreshAccount(commandApiB, queryApiB, "500");

    // customer-accounts-projector(docs/adr/0016決定4)の反映待ち——account.event.Openedの
    // outbox発行を経由する結果整合性なので、他の投影(owner_projector等)と同じくwaitForで待つ。
    const myAccounts = await waitFor(
      async () => {
        const accounts = await queryApiA.getMyAccounts();
        return accounts.some((a) => a.accountId === accountIdA) ? accounts : undefined;
      },
      { description: `identityA's customers/me/accounts to include ${accountIdA}` },
    );

    expect(myAccounts.map((a) => a.accountId)).toContain(accountIdA);
    expect(myAccounts.map((a) => a.accountId)).not.toContain(accountIdB);
  });
});

describe("FC18b: 保護されたエンドポイントはAuthorizationヘッダーが無ければ401になる", () => {
  it("Authorizationヘッダー無しのGET /accounts/{accountId}は401を返す", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const accountId = await openFreshAccount(commandApi, queryApi, "100");

    // `createQueryApi`のidTokenを省略した素のrawRequestで、無認証のまま同じエンドポイントを叩く。
    const response = await rawRequest(`${outputs.queryApiUrl}/accounts/${accountId}`);

    expect(response.status).toBe(401);
  });
});

describe("FC18c: Deposit/Withdraw(外部チャネル)は引き続き認証不要のまま動く", () => {
  it("Authorizationヘッダーを一切付けずにDepositしても残高に反映される", async () => {
    const outputs = await fetchStackOutputs();
    // 口座の開設・残高照会には認証が要る(決定2)ので、それらには認証済み識別子を使う。
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const accountId = await openFreshAccount(commandApi, queryApi, "0");

    // Deposit自体は`idToken`を渡さない(=無認証の)CommandApiで呼ぶ——ADR-0009決定1の
    // 「外部チャネル」の想定通り、Cognito Authorizerがそもそも付いていないエンドポイントである
    // ことを確認する。
    const unauthenticatedCommandApi = createCommandApi(outputs.commandApiUrl);
    const depositResponse = await unauthenticatedCommandApi.deposit(accountId, "50");
    expect(depositResponse.status).toBe(202);

    await waitFor(
      async () => {
        const view = await queryApi.getAccount(accountId);
        return view && Number(view.balance) === 50 ? view : undefined;
      },
      { description: `account ${accountId} balance to reach 50 after unauthenticated deposit` },
    );

    const withdrawResponse = await unauthenticatedCommandApi.withdraw(accountId, "20");
    expect(withdrawResponse.status).toBe(202);

    const afterWithdraw = await waitFor(
      async () => {
        const view = await queryApi.getAccount(accountId);
        return view && Number(view.balance) === 30 ? view : undefined;
      },
      { description: `account ${accountId} balance to reach 30 after unauthenticated withdrawal` },
    );
    expect(afterWithdraw.status).toBe("active");
  });
});

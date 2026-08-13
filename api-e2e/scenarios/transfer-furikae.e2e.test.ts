// Covers docs/e2e-scenarios.md FC10 (旧J1/J2/J4/J7)・R6 (旧J3) (振替=同一名義間、docs/adr/0011)。
// 同一owner_idの2口座間の送金は`kind=furikae`と判定され、確認(J5/J6)を経由せず即座に
// 開始される(J7)——このファイルの全テストがその前提の上で書かれている。
//
// 同一名義は、同一のCognito認証済み識別子(docs/adr/0016決定3)で送金元・送金先双方の口座を
// 開設することで作る——owner_idはもはやリクエストボディの自己申告値ではない。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { REJECTION_SETTLE_MS, settle, waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";
import { createTransferCommandApi, createTransferQueryApi, waitForTransferState } from "../support/transferClient";
import { signUpAndSignIn } from "../support/auth";

describe("J1/J7: 振替(同一名義)は確認不要で即座に開始され、残高が反映される", () => {
  it("送金元が減り、送金先が同額増える", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identity.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identity.idToken);
    const fromId = await openFreshAccount(commandApi, queryApi, "1000.00");
    const toId = await openFreshAccount(commandApi, queryApi, "0.00");
    const transferId = crypto.randomUUID();

    const startResponse = await transferCommandApi.start({
      transferId,
      fromAccountId: fromId,
      toAccountId: toId,
      amount: "300.00",
    });
    expect(startResponse.status).toBe(202);

    const status = await waitForTransferState(transferQueryApi, transferId, ["credited"]);
    expect(status.kind).toBe("furikae");

    await waitFor(
      async () => {
        const view = await queryApi.getAccount(fromId);
        return view && Number(view.balance) === 700 ? view : undefined;
      },
      { description: `account ${fromId} balance to reach 700 after furikae` },
    );
    await waitFor(
      async () => {
        const view = await queryApi.getAccount(toId);
        return view && Number(view.balance) === 300 ? view : undefined;
      },
      { description: `account ${toId} balance to reach 300 after furikae` },
    );
  });
});

describe("J2: 送金元の残高不足は送金先に一切影響しない", () => {
  it("出金コマンド自体が却下され、双方の残高が変化しない", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identity.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identity.idToken);
    const fromId = await openFreshAccount(commandApi, queryApi, "100.00");
    const toId = await openFreshAccount(commandApi, queryApi, "0.00");
    const transferId = crypto.randomUUID();

    const startResponse = await transferCommandApi.start({
      transferId,
      fromAccountId: fromId,
      toAccountId: toId,
      amount: "500.00",
    });
    expect(startResponse.status).toBe(202);

    const status = await waitForTransferState(transferQueryApi, transferId, ["failed"]);
    expect(status.state).toBe("failed");

    const fromView = await queryApi.getAccount(fromId);
    const toView = await queryApi.getAccount(toId);
    expect(Number(fromView?.balance)).toBe(100.0);
    expect(Number(toView?.balance)).toBe(0.0);
  });
});

describe("J3: 送金先が入金を受け付けられない場合、送金元へ補償される", () => {
  it("送金先が凍結中だと、出金は成功するが最終的に送金元へ全額補償される", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identity.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identity.idToken);
    const fromId = await openFreshAccount(commandApi, queryApi, "1000.00");
    const toId = await openFreshAccount(commandApi, queryApi, "0.00");

    const freezeResponse = await commandApi.freeze(toId, "CustomerRequest");
    expect(freezeResponse.status).toBe(202);
    await waitFor(
      async () => {
        const view = await queryApi.getAccount(toId);
        return view?.status === "frozen" ? view : undefined;
      },
      { description: `account ${toId} to become frozen` },
    );

    const transferId = crypto.randomUUID();
    const startResponse = await transferCommandApi.start({
      transferId,
      fromAccountId: fromId,
      toAccountId: toId,
      amount: "300.00",
    });
    expect(startResponse.status).toBe(202);

    const status = await waitForTransferState(transferQueryApi, transferId, ["compensated"]);
    expect(status.state).toBe("compensated");

    await waitFor(
      async () => {
        const view = await queryApi.getAccount(fromId);
        return view && Number(view.balance) === 1000 ? view : undefined;
      },
      { description: `account ${fromId} balance to be restored to 1000 after compensation` },
    );
    const toView = await queryApi.getAccount(toId);
    expect(Number(toView?.balance)).toBe(0.0);
  });
});

describe("J4: 同一口座への送金は要求時点で却下される", () => {
  it("サガは作成されず、残高も変化しない", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identity.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identity.idToken);
    const accountId = await openFreshAccount(commandApi, queryApi, "100.00");
    const transferId = crypto.randomUUID();

    await transferCommandApi.start({
      transferId,
      fromAccountId: accountId,
      toAccountId: accountId,
      amount: "50.00",
    });

    // account-domainのDomainErrorと同様、決定論的な拒否には正の観測シグナルがない
    // (poll.tsの`settle`と同じ考え方)。SQS経由でも(account-serviceのようなoutboxを
    // 経由しないため)十分な時間待てば処理は終わっているはずである。
    await settle(REJECTION_SETTLE_MS);

    const status = await transferQueryApi.getTransferStatus(transferId);
    expect(status).toBeNull();

    const view = await queryApi.getAccount(accountId);
    expect(Number(view?.balance)).toBe(100.0);
  });
});

// FC13(docs/decision-tables.md発見: saga.rsのStartErrorのうちSameAccount/ExceedsFurikomiLimitは
// 検証済みだったが、NonPositiveAmountは一度もE2E検証されていなかった)。APIGWの構造検証
// (decimalStringSchema、`^-?\d+(\.\d{1,2})?$`)は正負を見ないため、"0"・"-10"はSQSまで到達し、
// saga::startのドメイン層で初めて拒否される——account-serviceのB8/FC3と同じ境界。
// InvalidAmountPrecision側("10.123"のような3桁超)はこのパターンとは逆にAPIGWレベルで
// 4xx拒否されるため(account-serviceのFC7と同じ理由)、この構造検証を経由するE2Eでは到達
// できず、saga.rsの単体テストのみでカバーする。
describe("FC13: 非正の金額でのStartは受付時点で却下される", () => {
  it.each([["ゼロ", "0"], ["負値", "-10"]])("%sの金額はサガを作成せず、残高も変化しない", async (_label, amount) => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identity.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identity.idToken);
    const fromId = await openFreshAccount(commandApi, queryApi, "100.00");
    const toId = await openFreshAccount(commandApi, queryApi, "0.00");
    const transferId = crypto.randomUUID();

    await transferCommandApi.start({ transferId, fromAccountId: fromId, toAccountId: toId, amount });
    await settle(REJECTION_SETTLE_MS);

    const status = await transferQueryApi.getTransferStatus(transferId);
    expect(status).toBeNull();
    const fromView = await queryApi.getAccount(fromId);
    expect(Number(fromView?.balance)).toBe(100.0);
  });
});

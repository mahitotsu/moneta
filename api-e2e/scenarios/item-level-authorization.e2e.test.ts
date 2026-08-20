// Covers docs/production-readiness-matrix.md S1(旧残存ギャップ、docs/adr/0027で解消)。
// docs/adr/0016は「認証済みの別人が他人のaccountId/transferIdを直接指定すれば
// GET /accounts/{id}・GET /transfers/{id}を閲覧できてしまう」ギャップを既知のトレードオフとして
// 記録していた——2026-08-18のセッションで実際に他人の送金を閲覧できることを直接確認済み。
// docs/adr/0027はitem単位の読み取り認可(AccountViewTable/AccountHistoryTable/
// TransferStatusViewTableの各アイテムが持つownerId/fromOwnerId/toOwnerIdとJWTのsubクレームを
// 比較する)で解消した。このファイルは、その403判定そのものと、所有者からは引き続き200で
// 見えることの両方を検証する。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi, rawRequest } from "../support/httpClient";
import { openFreshAccount } from "../support/testAccount";
import { createTransferCommandApi, createTransferQueryApi, waitForTransferState } from "../support/transferClient";
import { waitForOwnerIndexed } from "../support/sagaState";
import { signUpAndSignIn } from "../support/auth";

describe("docs/adr/0027決定1: GET /accounts/{accountId}は名義本人以外に403を返す", () => {
  it("他人の口座は403、本人は引き続き200で見える", async () => {
    const outputs = await fetchStackOutputs();
    const owner = await signUpAndSignIn(outputs.userPoolClientId);
    const stranger = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, owner.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, owner.idToken);
    const accountId = await openFreshAccount(commandApi, queryApi, "100.00");

    const asStranger = await rawRequest(`${outputs.queryApiUrl}/accounts/${accountId}`, {
      headers: { Authorization: `Bearer ${stranger.idToken}` },
    });
    expect(asStranger.status).toBe(403);

    const asOwner = await rawRequest(`${outputs.queryApiUrl}/accounts/${accountId}`, {
      headers: { Authorization: `Bearer ${owner.idToken}` },
    });
    expect(asOwner.status).toBe(200);
  });
});

describe("docs/adr/0027決定1: GET /accounts/{accountId}/transactionsは名義本人以外に403を返す", () => {
  it("他人の口座の取引履歴は403、本人は引き続き200・自分の履歴が見える", async () => {
    const outputs = await fetchStackOutputs();
    const owner = await signUpAndSignIn(outputs.userPoolClientId);
    const stranger = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, owner.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, owner.idToken);
    const accountId = await openFreshAccount(commandApi, queryApi, "100.00");

    const asStranger = await rawRequest(`${outputs.queryApiUrl}/accounts/${accountId}/transactions`, {
      headers: { Authorization: `Bearer ${stranger.idToken}` },
    });
    expect(asStranger.status).toBe(403);

    // 本人が見れば、口座開設時のEvent::Openedが必ず生む「opened」エントリが少なくとも1件ある
    // (history.rs、docs/adr/0027の「実在する口座は空配列になり得ない」という前提そのものの確認)。
    const history = await queryApi.getTransactionHistory(accountId);
    expect(history.some((entry) => entry.type === "opened")).toBe(true);
  });
});

describe("docs/adr/0027決定2: GET /transfers/{transferId}は送金元・送金先以外に403を返す", () => {
  it("無関係な第三者は403、送金元・送金先はどちらも200で見える", async () => {
    const outputs = await fetchStackOutputs();
    const [sender, receiver, stranger] = await Promise.all([
      signUpAndSignIn(outputs.userPoolClientId),
      signUpAndSignIn(outputs.userPoolClientId),
      signUpAndSignIn(outputs.userPoolClientId),
    ]);
    const commandApiSender = createCommandApi(outputs.commandApiUrl, sender.idToken);
    const commandApiReceiver = createCommandApi(outputs.commandApiUrl, receiver.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, sender.idToken);
    const fromId = await openFreshAccount(commandApiSender, queryApi, "1000.00");
    const toId = await openFreshAccount(commandApiReceiver, queryApi, "0.00");

    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, sender.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, sender.idToken);
    const transferId = crypto.randomUUID();
    const startResponse = await transferCommandApi.start({ transferId, fromAccountId: fromId, toAccountId: toId, amount: "300.00" });
    expect(startResponse.status).toBe(202);

    // fromOwnerId/toOwnerIdはサガ作成時点(TransferSagaTableへの最初の書き込み)から既に
    // 揃っている(persistence.rsのsaga_to_item、docs/adr/0027)ため、確認(Confirm)を待たず
    // pending_confirmationの時点で403判定を検証できる——確認以降の状態遷移は他のシナリオ
    // (transfer-furikomi.e2e.test.ts)が既に検証済みで、ここでの関心事ではない。
    await waitForTransferState(transferQueryApi, transferId, ["pending_confirmation"]);

    const asStranger = await rawRequest(`${outputs.transferQueryApiUrl}/transfers/${transferId}`, {
      headers: { Authorization: `Bearer ${stranger.idToken}` },
    });
    expect(asStranger.status).toBe(403);

    const asSender = await rawRequest(`${outputs.transferQueryApiUrl}/transfers/${transferId}`, {
      headers: { Authorization: `Bearer ${sender.idToken}` },
    });
    expect(asSender.status).toBe(200);

    const asReceiver = await rawRequest(`${outputs.transferQueryApiUrl}/transfers/${transferId}`, {
      headers: { Authorization: `Bearer ${receiver.idToken}` },
    });
    expect(asReceiver.status).toBe(200);
  });
});

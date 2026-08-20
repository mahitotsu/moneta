// Covers docs/adr/0025: GET /customers/me/points(PointsQueryApi)がpoints-serviceのPointsTableを
// 正しく解決することをHTTPレベルで検証する。scenarios/transfer-fee-and-points.e2e.test.tsは
// PointsTableをDynamoDB直接読みで検証していたが、このAPI自体(GetItem統合、ownerIdの
// JWT解決、項目が存在しない場合の既定値)は一度も実際に叩いていなかった。
import { fetchStackOutputs } from "../support/stackOutputs";
import { authHeaders, createCommandApi, createQueryApi, getMyPointsHistory, rawRequest } from "../support/httpClient";
import { waitForPointsBalance } from "../support/pointsState";
import { waitForOwnerIndexed } from "../support/sagaState";
import { openFreshAccount } from "../support/testAccount";
import { createTransferCommandApi, createTransferQueryApi, waitForTransferState } from "../support/transferClient";
import { signUpAndSignIn } from "../support/auth";

async function getMyPoints(pointsQueryApiUrl: string, idToken: string) {
  return rawRequest<{ balance: string }>(`${pointsQueryApiUrl}/customers/me/points`, { headers: authHeaders(idToken) });
}

describe("GET /customers/me/points(docs/adr/0025)", () => {
  it("一度もポイントを獲得したことがない顧客には0が返る", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);

    const response = await getMyPoints(outputs.pointsQueryApiUrl, identity.idToken);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ balance: "0" });
  });

  it("認証なしのリクエストは401になる", async () => {
    const outputs = await fetchStackOutputs();
    const response = await rawRequest(`${outputs.pointsQueryApiUrl}/customers/me/points`);
    expect(response.status).toBe(401);
  });

  it("振込の着金でポイントが付与された後は、そのownerIdの残高が反映される", async () => {
    const outputs = await fetchStackOutputs();
    const [identityA, identityB] = await Promise.all([
      signUpAndSignIn(outputs.userPoolClientId),
      signUpAndSignIn(outputs.userPoolClientId),
    ]);
    const commandApiA = createCommandApi(outputs.commandApiUrl, identityA.idToken);
    const commandApiB = createCommandApi(outputs.commandApiUrl, identityB.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identityA.idToken);
    // docs/adr/0027: GET /accounts/{id}はitem単位の認可を持つため、口座Bの状態確認は
    // 口座Bの名義(identityB)のqueryApiで行う——identityAのqueryApiで問い合わせると403になる。
    const queryApiB = createQueryApi(outputs.queryApiUrl, identityB.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identityA.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identityA.idToken);

    const fromId = await openFreshAccount(commandApiA, queryApi, "1000.00");
    const toId = await openFreshAccount(commandApiB, queryApiB, "0.00");
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

    const transferId = crypto.randomUUID();
    await transferCommandApi.start({ transferId, fromAccountId: fromId, toAccountId: toId, amount: "300.00" });
    await waitForTransferState(transferQueryApi, transferId, ["pending_confirmation"]);
    await transferCommandApi.confirm(transferId);
    await waitForTransferState(transferQueryApi, transferId, ["credited"], { timeoutMs: 45_000 });

    // AwardPointsの反映(fire-and-forget、docs/adr/0024決定6)を待ってから、
    // 同じ値がAPI経由でも見えることを確認する。
    await waitForPointsBalance(outputs.pointsTableName, identityB.sub, 300 * 0.001, { timeoutMs: 45_000 });

    // 文字列の桁数(rust_decimalの乗算がscaleをどう持ち越すか)まではAPIの契約として
    // 固定しない——数値としての一致だけを見る(support/pointsState.tsのgetPointsBalanceと
    // 同じ変換)。
    const response = await getMyPoints(outputs.pointsQueryApiUrl, identityB.idToken);
    expect(response.status).toBe(200);
    expect(Number((response.body as { balance: string }).balance)).toBe(300 * 0.001);
  });
});

// docs/adr/0026: GET /customers/me/points/history。同じ振込フローを再利用し(新規の送金は
// 起こさない)、着金による付与が履歴の1行として正しく見えることをHTTPレベルで検証する。
describe("GET /customers/me/points/history(docs/adr/0026)", () => {
  it("振込の着金による付与が、正しい種別・金額・transferIdの履歴として見える", async () => {
    const outputs = await fetchStackOutputs();
    const [identityA, identityB] = await Promise.all([
      signUpAndSignIn(outputs.userPoolClientId),
      signUpAndSignIn(outputs.userPoolClientId),
    ]);
    const commandApiA = createCommandApi(outputs.commandApiUrl, identityA.idToken);
    const commandApiB = createCommandApi(outputs.commandApiUrl, identityB.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identityA.idToken);
    // docs/adr/0027: GET /accounts/{id}はitem単位の認可を持つため、口座Bの状態確認は
    // 口座Bの名義(identityB)のqueryApiで行う——identityAのqueryApiで問い合わせると403になる。
    const queryApiB = createQueryApi(outputs.queryApiUrl, identityB.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identityA.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identityA.idToken);

    const fromId = await openFreshAccount(commandApiA, queryApi, "1000.00");
    const toId = await openFreshAccount(commandApiB, queryApiB, "0.00");
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

    const transferId = crypto.randomUUID();
    await transferCommandApi.start({ transferId, fromAccountId: fromId, toAccountId: toId, amount: "300.00" });
    await waitForTransferState(transferQueryApi, transferId, ["pending_confirmation"]);
    await transferCommandApi.confirm(transferId);
    await waitForTransferState(transferQueryApi, transferId, ["credited"], { timeoutMs: 45_000 });
    await waitForPointsBalance(outputs.pointsTableName, identityB.sub, 300 * 0.001, { timeoutMs: 45_000 });

    const response = await getMyPointsHistory(outputs.pointsQueryApiUrl, identityB.idToken);
    expect(response.status).toBe(200);
    const entry = response.body.find((e) => e.transferId === transferId);
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("awarded");
    expect(Number(entry?.amount)).toBe(300 * 0.001);
  });

  it("認証なしのリクエストは401になる", async () => {
    const outputs = await fetchStackOutputs();
    const response = await rawRequest(`${outputs.pointsQueryApiUrl}/customers/me/points/history`);
    expect(response.status).toBe(401);
  });
});

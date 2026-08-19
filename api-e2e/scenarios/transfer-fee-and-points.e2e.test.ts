// Covers docs/adr/0024の残作業(次のステップ7): 振込の手数料徴収・ポイント充当・失敗時の
// 返却。transfer-furikomi.e2e.test.ts/transfer-recall.e2e.test.tsは「保有ポイント0(現金
// 全額負担)」のケースしか検証していなかった——fee-service/points-serviceのコード自体は
// デプロイ済みだが、ポイント付与(AwardPoints)・ポイント充当(ReservePoints)・失敗時の返却
// (RefundFee/RefundPoints)は一度も実際に動くところを確認していなかった、というギャップを
// 埋める。
//
// ポイント台帳(PointsTable)・手数料予約台帳(FeeReservationsTable)には照会APIが無い
// (バックエンド専用、docs/adr/0024はUIをスコープ外にしている)ため、
// support/pointsState.tsで直接DynamoDBを読む——support/sagaState.tsのwaitForOwnerIndexedと
// 同じ位置づけの正当な検証手段。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi, getMyPointsHistory } from "../support/httpClient";
import { waitFor } from "../support/poll";
import { waitForOwnerIndexed } from "../support/sagaState";
import { seedPointsBalance, waitForFeeReservationState, waitForPointsBalance } from "../support/pointsState";
import { openFreshAccount, waitForStatus } from "../support/testAccount";
import { createTransferCommandApi, createTransferQueryApi, waitForTransferState } from "../support/transferClient";
import { signUpAndSignIn, subFromIdToken, TestIdentity } from "../support/auth";

// fee-service/src/reservation.rsのfurikomi_fee_amount()と同じ固定額(docs/adr/0024決定2)。
const FURIKOMI_FEE = 220;
// transfer-service/src/saga.rsのaward_points_for()と同じ付与率(送金額の0.1%、決定7)。
const AWARD_RATE = 0.001;

async function distinctIdentities(clientId: string): Promise<[TestIdentity, TestIdentity]> {
  return Promise.all([signUpAndSignIn(clientId), signUpAndSignIn(clientId)]);
}

describe("振込の着金でポイントが付与される(docs/adr/0024決定7)", () => {
  it("受取人のポイント残高が送金額の0.1%だけ増える", async () => {
    const outputs = await fetchStackOutputs();
    const [identityA, identityB] = await distinctIdentities(outputs.userPoolClientId);
    const commandApiA = createCommandApi(outputs.commandApiUrl, identityA.idToken);
    const commandApiB = createCommandApi(outputs.commandApiUrl, identityB.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identityA.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identityA.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identityA.idToken);
    const toOwnerId = subFromIdToken(identityB.idToken);
    expect(toOwnerId).toBeDefined();

    const fromId = await openFreshAccount(commandApiA, queryApi, "1000.00");
    const toId = await openFreshAccount(commandApiB, queryApi, "0.00");
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

    const transferId = crypto.randomUUID();
    await transferCommandApi.start({ transferId, fromAccountId: fromId, toAccountId: toId, amount: "300.00" });
    await waitForTransferState(transferQueryApi, transferId, ["pending_confirmation"]);
    await transferCommandApi.confirm(transferId);
    await waitForTransferState(transferQueryApi, transferId, ["credited"]);

    await waitForPointsBalance(outputs.pointsTableName, toOwnerId!, 300 * AWARD_RATE, { timeoutMs: 45_000 });
  });
});

describe("保有ポイントで手数料の一部を充当できる(docs/adr/0024決定3・決定4)", () => {
  it("充当分だけ現金負担が減り、ポイント残高が消費される", async () => {
    const outputs = await fetchStackOutputs();
    const [identityA, identityB] = await distinctIdentities(outputs.userPoolClientId);
    const commandApiA = createCommandApi(outputs.commandApiUrl, identityA.idToken);
    const commandApiB = createCommandApi(outputs.commandApiUrl, identityB.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identityA.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identityA.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identityA.idToken);
    const fromOwnerId = subFromIdToken(identityA.idToken);
    expect(fromOwnerId).toBeDefined();

    // 手数料(220円)の一部だけ賄えるポイント(100pt)を事前に持たせる——保有ポイントを素早く
    // 作る公開経路が無いため直接シードする(support/pointsState.tsのコメント参照)。
    const seededPoints = 100;
    await seedPointsBalance(outputs.pointsTableName, fromOwnerId!, seededPoints);

    const fromId = await openFreshAccount(commandApiA, queryApi, "1000.00");
    const toId = await openFreshAccount(commandApiB, queryApi, "0.00");
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

    const transferId = crypto.randomUUID();
    await transferCommandApi.start({ transferId, fromAccountId: fromId, toAccountId: toId, amount: "300.00" });
    await waitForTransferState(transferQueryApi, transferId, ["pending_confirmation"]);
    await transferCommandApi.confirm(transferId);
    await waitForTransferState(transferQueryApi, transferId, ["credited"], { timeoutMs: 45_000 });

    const reservation = await waitForFeeReservationState(outputs.feeReservationsTableName, transferId, ["reserved"]);
    expect(reservation.pointsUsed).toBe(seededPoints);
    expect(reservation.feeAmount).toBe(FURIKOMI_FEE);

    const cashPortion = FURIKOMI_FEE - seededPoints;
    await waitFor(
      async () => {
        const view = await queryApi.getAccount(fromId);
        // 1000 - 300(送金額) - 120(現金負担分の手数料、220-100pt) = 580。
        return view && Number(view.balance) === 1000 - 300 - cashPortion ? view : undefined;
      },
      { description: `account ${fromId} balance to reflect the points-reduced cash fee` },
    );

    // docs/adr/0025決定3・4: 送金詳細画面が表示するcashFee/pointsUsedも、DynamoDB直接読みの
    // reservationと同じ値をGET /transfers/{transferId}経由で確認できる。
    const status = await transferQueryApi.getTransferStatus(transferId);
    expect(Number(status?.cashFee)).toBe(cashPortion);
    expect(Number(status?.pointsUsed)).toBe(seededPoints);
    await waitForPointsBalance(outputs.pointsTableName, fromOwnerId!, 0); // 保有ポイントを使い切った。

    // docs/adr/0026: 充当(reserved)がポイント履歴の1行として、正しい種別・金額・transferIdで見える。
    const historyResponse = await getMyPointsHistory(outputs.pointsQueryApiUrl, identityA.idToken);
    expect(historyResponse.status).toBe(200);
    const historyEntry = historyResponse.body.find((e) => e.transferId === transferId);
    expect(historyEntry?.type).toBe("reserved");
    expect(Number(historyEntry?.amount)).toBe(seededPoints);
  });
});

describe("送金が失敗した場合、消費したポイントは返却される(docs/adr/0024決定5)", () => {
  it("残高不足でPendingDebitが却下されると、ポイントは全額返却される", async () => {
    const outputs = await fetchStackOutputs();
    const [identityA, identityB] = await distinctIdentities(outputs.userPoolClientId);
    const commandApiA = createCommandApi(outputs.commandApiUrl, identityA.idToken);
    const commandApiB = createCommandApi(outputs.commandApiUrl, identityB.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identityA.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identityA.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identityA.idToken);
    const fromOwnerId = subFromIdToken(identityA.idToken);
    expect(fromOwnerId).toBeDefined();

    // 手数料(220円)を全額賄えるだけのポイントを持たせる——原資確保(ReservingFee)自体は
    // 常に成立する(docs/adr/0024決定3)ため、cash_fee=0になる。
    await seedPointsBalance(outputs.pointsTableName, fromOwnerId!, FURIKOMI_FEE);

    // 送金額(300円)そのものに満たない残高にしておく——PendingDebitのWithdraw(300+0)が
    // 残高不足で却下されるようにする。
    const fromId = await openFreshAccount(commandApiA, queryApi, "100.00");
    const toId = await openFreshAccount(commandApiB, queryApi, "0.00");
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

    const transferId = crypto.randomUUID();
    await transferCommandApi.start({ transferId, fromAccountId: fromId, toAccountId: toId, amount: "300.00" });
    await waitForTransferState(transferQueryApi, transferId, ["pending_confirmation"]);
    await transferCommandApi.confirm(transferId);

    const status = await waitForTransferState(transferQueryApi, transferId, ["failed"], { timeoutMs: 45_000 });
    expect(status.state).toBe("failed");

    // 出金自体が却下されたので、口座残高は一切変化していない。
    const fromView = await queryApi.getAccount(fromId);
    expect(Number(fromView?.balance)).toBe(100.0);

    const reservation = await waitForFeeReservationState(outputs.feeReservationsTableName, transferId, ["refunded"], {
      timeoutMs: 45_000,
    });
    expect(reservation.pointsUsed).toBe(FURIKOMI_FEE);

    await waitForPointsBalance(outputs.pointsTableName, fromOwnerId!, FURIKOMI_FEE); // 消費した220ptが全額戻る。

    // docs/adr/0026: 充当(reserved)・返却(refunded)がどちらもポイント履歴に残る。
    const historyResponse = await getMyPointsHistory(outputs.pointsQueryApiUrl, identityA.idToken);
    expect(historyResponse.status).toBe(200);
    const entriesForTransfer = historyResponse.body.filter((e) => e.transferId === transferId);
    expect(entriesForTransfer.map((e) => e.type).sort()).toEqual(["refunded", "reserved"]);
    for (const e of entriesForTransfer) {
      expect(Number(e.amount)).toBe(FURIKOMI_FEE);
    }
  });

  // docs/decision-tables.md発見6: 上のテストは`PendingDebit`が却下されて`Failed`になる経路
  // (原資確保後、送金元自身の出金が失敗する)しかカバーしていなかった。もう1つの巻き戻し経路
  // ——送金先の入金が却下されて`Compensating`→`Compensated`になる場合も同様にポイントが
  // 返却されることを、受取人側の口座を凍結してから振込むことで再現する。
  it("送金先の入金が却下されてCompensatingで補償される場合も、ポイントは全額返却される", async () => {
    const outputs = await fetchStackOutputs();
    const [identityA, identityB] = await distinctIdentities(outputs.userPoolClientId);
    const commandApiA = createCommandApi(outputs.commandApiUrl, identityA.idToken);
    const commandApiB = createCommandApi(outputs.commandApiUrl, identityB.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identityA.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identityA.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identityA.idToken);
    const fromOwnerId = subFromIdToken(identityA.idToken);
    expect(fromOwnerId).toBeDefined();

    // 手数料(220円)を全額賄えるだけのポイントを持たせる——cash_fee=0になるため、
    // PendingDebit自体は(送金額分の残高さえあれば)確実に成功する。
    await seedPointsBalance(outputs.pointsTableName, fromOwnerId!, FURIKOMI_FEE);

    const fromId = await openFreshAccount(commandApiA, queryApi, "1000.00");
    const toId = await openFreshAccount(commandApiB, queryApi, "0.00");
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

    // 送金先を凍結しておく——PendingCreditのDepositがAccountFrozenで却下され、
    // Compensatingへ進むようにする(FC4と同じ凍結操作)。
    const freezeResponse = await commandApiB.freeze(toId, "CustomerRequest");
    expect(freezeResponse.status).toBe(202);
    await waitForStatus(queryApi, toId, "frozen");

    const transferId = crypto.randomUUID();
    await transferCommandApi.start({ transferId, fromAccountId: fromId, toAccountId: toId, amount: "300.00" });
    await waitForTransferState(transferQueryApi, transferId, ["pending_confirmation"]);
    await transferCommandApi.confirm(transferId);

    const status = await waitForTransferState(transferQueryApi, transferId, ["compensated"], { timeoutMs: 60_000 });
    expect(status.state).toBe("compensated");

    // 補償(送金額+現金負担分の手数料=0)により、送金元の残高は元通り。
    const fromView = await queryApi.getAccount(fromId);
    expect(Number(fromView?.balance)).toBe(1000.0);

    const reservation = await waitForFeeReservationState(outputs.feeReservationsTableName, transferId, ["refunded"], {
      timeoutMs: 45_000,
    });
    expect(reservation.pointsUsed).toBe(FURIKOMI_FEE);

    await waitForPointsBalance(outputs.pointsTableName, fromOwnerId!, FURIKOMI_FEE); // 消費した220ptが全額戻る。

    // docs/adr/0026: Compensating経路でも同様に、充当(reserved)・返却(refunded)がどちらも
    // ポイント履歴に残る。
    const historyResponse = await getMyPointsHistory(outputs.pointsQueryApiUrl, identityA.idToken);
    expect(historyResponse.status).toBe(200);
    const entriesForTransfer = historyResponse.body.filter((e) => e.transferId === transferId);
    expect(entriesForTransfer.map((e) => e.type).sort()).toEqual(["refunded", "reserved"]);
    for (const e of entriesForTransfer) {
      expect(Number(e.amount)).toBe(FURIKOMI_FEE);
    }
  });
});

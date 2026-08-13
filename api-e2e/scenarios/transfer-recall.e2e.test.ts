// Covers docs/e2e-scenarios.md FC12 (旧J9/J10) (組戻し=recall、docs/adr/0011決定5)。
// 組戻しは新しい終端状態を追加せず、`kind=recall`の新しいサガとして`start`を再利用する
// 設計(saga.rs)。適格性(`recall_eligibility`)は kind==furikomi ・ state==credited ・
// 時間窓(24時間)以内、の3条件——このファイルはその3条件それぞれの成立/不成立を検証する。
//
// 名義不一致(furikomi)は、2つの別々のCognito認証済み識別子(docs/adr/0016決定3)でそれぞれの
// 口座を開設することで作る——owner_idはもはやリクエストボディの自己申告値ではない。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { REJECTION_SETTLE_MS, settle, waitFor } from "../support/poll";
import { backdateSagaUpdatedAt, waitForOwnerIndexed } from "../support/sagaState";
import { openFreshAccount } from "../support/testAccount";
import {
  createTransferCommandApi,
  createTransferQueryApi,
  TransferCommandApi,
  TransferQueryApi,
  waitForTransferState,
} from "../support/transferClient";
import { signUpAndSignIn, TestIdentity } from "../support/auth";

async function distinctIdentities(clientId: string): Promise<[TestIdentity, TestIdentity]> {
  return Promise.all([signUpAndSignIn(clientId), signUpAndSignIn(clientId)]);
}

// Given-step共通処理: 名義不一致の2口座を開設し、300円の振込をcredited(着金済み)まで
// 進める。J9/J10それぞれがこの直後から分岐する。
async function creditedFurikomi(
  commandApiA: ReturnType<typeof createCommandApi>,
  commandApiB: ReturnType<typeof createCommandApi>,
  queryApi: ReturnType<typeof createQueryApi>,
  transferCommandApi: TransferCommandApi,
  transferQueryApi: TransferQueryApi,
  outputs: Awaited<ReturnType<typeof fetchStackOutputs>>,
) {
  const fromId = await openFreshAccount(commandApiA, queryApi, "1000.00");
  const toId = await openFreshAccount(commandApiB, queryApi, "0.00");
  await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
  await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

  const transferId = crypto.randomUUID();
  await transferCommandApi.start({ transferId, fromAccountId: fromId, toAccountId: toId, amount: "300.00" });
  await waitForTransferState(transferQueryApi, transferId, ["pending_confirmation"]);
  await transferCommandApi.confirm(transferId);
  await waitForTransferState(transferQueryApi, transferId, ["credited"]);

  return { fromId, toId, transferId };
}

describe("J9: 期限内のCredited済み振込は組戻しできる", () => {
  it("受取人から送金元へ全額が戻る", async () => {
    const outputs = await fetchStackOutputs();
    const [identityA, identityB] = await distinctIdentities(outputs.userPoolClientId);
    const commandApiA = createCommandApi(outputs.commandApiUrl, identityA.idToken);
    const commandApiB = createCommandApi(outputs.commandApiUrl, identityB.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identityA.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identityA.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identityA.idToken);
    const { fromId, toId, transferId } = await creditedFurikomi(
      commandApiA,
      commandApiB,
      queryApi,
      transferCommandApi,
      transferQueryApi,
      outputs,
    );

    const recallId = crypto.randomUUID();
    const recallResponse = await transferCommandApi.recall({ transferId: recallId, originalTransferId: transferId });
    expect(recallResponse.status).toBe(202);

    const status = await waitForTransferState(transferQueryApi, recallId, ["credited"]);
    expect(status.kind).toBe("recall");
    // 組戻しは受取人→送金元の逆方向送金として実装される(docs/adr/0011決定5)。
    expect(status.fromAccountId).toBe(toId);
    expect(status.toAccountId).toBe(fromId);

    await waitFor(
      async () => {
        const view = await queryApi.getAccount(fromId);
        return view && Number(view.balance) === 1000 ? view : undefined;
      },
      { description: `account ${fromId} balance to be restored to 1000 after recall` },
    );
    await waitFor(
      async () => {
        const view = await queryApi.getAccount(toId);
        return view && Number(view.balance) === 0 ? view : undefined;
      },
      { description: `account ${toId} balance to return to 0 after recall` },
    );
  });
});

describe("J10a: 受取人の残高不足での組戻しはfailedになる", () => {
  it("組戻し用サガがfailedになり、双方の残高は組戻し前のまま変化しない", async () => {
    const outputs = await fetchStackOutputs();
    const [identityA, identityB] = await distinctIdentities(outputs.userPoolClientId);
    const commandApiA = createCommandApi(outputs.commandApiUrl, identityA.idToken);
    const commandApiB = createCommandApi(outputs.commandApiUrl, identityB.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identityA.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identityA.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identityA.idToken);
    const { fromId, toId, transferId } = await creditedFurikomi(
      commandApiA,
      commandApiB,
      queryApi,
      transferCommandApi,
      transferQueryApi,
      outputs,
    );

    // 受取人側の残高を組戻し額(300)未満まで引き出しておく(受取人の識別子=commandApiBで行う、
    // docs/adr/0016決定3のownership検証)。
    const withdrawResponse = await commandApiB.withdraw(toId, "250.00");
    expect(withdrawResponse.status).toBe(202);
    await waitFor(
      async () => {
        const view = await queryApi.getAccount(toId);
        return view && Number(view.balance) === 50 ? view : undefined;
      },
      { description: `account ${toId} balance to drop to 50 before attempting recall` },
    );

    const recallId = crypto.randomUUID();
    await transferCommandApi.recall({ transferId: recallId, originalTransferId: transferId });

    const status = await waitForTransferState(transferQueryApi, recallId, ["failed"]);
    expect(status.state).toBe("failed");

    const fromView = await queryApi.getAccount(fromId);
    const toView = await queryApi.getAccount(toId);
    expect(Number(fromView?.balance)).toBe(700.0);
    expect(Number(toView?.balance)).toBe(50.0);
  });
});

describe("J10b: 組戻し可能な時間窓を過ぎている場合は受付時点で却下される", () => {
  it("saga.rsのRECALL_WINDOW(24時間)を過ぎたサガへのRecallはWindowExpiredで却下される", async () => {
    const outputs = await fetchStackOutputs();
    const [identityA, identityB] = await distinctIdentities(outputs.userPoolClientId);
    const commandApiA = createCommandApi(outputs.commandApiUrl, identityA.idToken);
    const commandApiB = createCommandApi(outputs.commandApiUrl, identityB.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identityA.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identityA.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identityA.idToken);
    const { fromId, toId, transferId } = await creditedFurikomi(
      commandApiA,
      commandApiB,
      queryApi,
      transferCommandApi,
      transferQueryApi,
      outputs,
    );

    // 実時間で24時間待つ代わりに、`updatedAt`を直接25時間前へ書き換えて期限切れを模擬する
    // (support/sagaState.tsのbackdateSagaUpdatedAtのコメント参照——テスト専用の裏口)。
    await backdateSagaUpdatedAt(outputs.transferSagaTableName, transferId, 25);

    const recallId = crypto.randomUUID();
    await transferCommandApi.recall({ transferId: recallId, originalTransferId: transferId });

    await settle(REJECTION_SETTLE_MS);

    const recallStatus = await transferQueryApi.getTransferStatus(recallId);
    expect(recallStatus).toBeNull();

    const fromView = await queryApi.getAccount(fromId);
    const toView = await queryApi.getAccount(toId);
    expect(Number(fromView?.balance)).toBe(700.0);
    expect(Number(toView?.balance)).toBe(300.0);
  });
});

// FC15(docs/decision-tables.md発見5): 組戻しは振込(furikomi)専用の操作で、振替(furikae)や
// 組戻し自体に対するRecallは`RecallError::NotFurikomi`で却下されるはずだが、単体のみでE2E
// 未検証だった。組戻しは振替では原理的に不要(顧客自身が別の振替をやり直せば足りる、saga.rs
// のコメント参照)という業務境界の外部観測。
describe("FC15: 振替(furikae)に対するRecallは却下される", () => {
  it("組戻し用サガは作成されず、残高も変化しない", async () => {
    const outputs = await fetchStackOutputs();
    // furikae: 送金元・送金先を同一の認証済み識別子にする(furikomiのcreditedFurikomiとは
    // 違い確認不要)。
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identity.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identity.idToken);
    const fromId = await openFreshAccount(commandApi, queryApi, "1000.00");
    const toId = await openFreshAccount(commandApi, queryApi, "0.00");
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

    const transferId = crypto.randomUUID();
    await transferCommandApi.start({ transferId, fromAccountId: fromId, toAccountId: toId, amount: "300.00" });
    const credited = await waitForTransferState(transferQueryApi, transferId, ["credited"]);
    expect(credited.kind).toBe("furikae");

    const recallId = crypto.randomUUID();
    await transferCommandApi.recall({ transferId: recallId, originalTransferId: transferId });
    await settle(REJECTION_SETTLE_MS);

    const recallStatus = await transferQueryApi.getTransferStatus(recallId);
    expect(recallStatus).toBeNull();

    const fromView = await queryApi.getAccount(fromId);
    const toView = await queryApi.getAccount(toId);
    expect(Number(fromView?.balance)).toBe(700.0);
    expect(Number(toView?.balance)).toBe(300.0);
  });
});

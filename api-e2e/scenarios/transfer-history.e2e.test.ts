// Covers docs/e2e-scenarios.md FC19 (docs/adr/0017): 顧客ごとの送金履歴が
// transfer-history-projector経由でサーバー側に反映されることを検証する。実デプロイでの
// 動作確認により、当初の設計(SKに`updatedAt`を含める)ではサガの状態遷移のたびに別アイテムが
// 積み上がる実バグがあったため、「複数回の状態遷移を経ても1件に収束する」ことを明示的に
// 固定するテストとして書く。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { openFreshAccount } from "../support/testAccount";
import { createTransferCommandApi, createTransferQueryApi, waitForTransferState } from "../support/transferClient";
import { signUpAndSignIn } from "../support/auth";
import { waitFor } from "../support/poll";

describe("FC19: 顧客ごとの送金履歴(GET /customers/me/transfers)", () => {
  it("振替(同一名義)は複数回の状態遷移(pending_debit→pending_credit→credited)を経ても、一覧には1件だけ現れる", async () => {
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
    await waitForTransferState(transferQueryApi, transferId, ["credited"]);

    const myTransfers = await waitFor(
      async () => {
        const transfers = await transferQueryApi.getMyTransfers();
        const matches = transfers.filter((t) => t.transferId === transferId);
        return matches.length > 0 ? matches : undefined;
      },
      { description: `transfer ${transferId} to appear in GET /customers/me/transfers` },
    );

    expect(myTransfers).toHaveLength(1);
    expect(myTransfers[0].state).toBe("credited");
    expect(myTransfers[0].kind).toBe("furikae");
  });

  it("振込(名義不一致)は送金元・送金先どちらの一覧にも同じtransferIdで1件ずつ現れる", async () => {
    const outputs = await fetchStackOutputs();
    const identityA = await signUpAndSignIn(outputs.userPoolClientId);
    const identityB = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApiA = createCommandApi(outputs.commandApiUrl, identityA.idToken);
    const commandApiB = createCommandApi(outputs.commandApiUrl, identityB.idToken);
    const queryApiA = createQueryApi(outputs.queryApiUrl, identityA.idToken);
    const queryApiB = createQueryApi(outputs.queryApiUrl, identityB.idToken);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identityA.idToken);
    const transferQueryApiA = createTransferQueryApi(outputs.transferQueryApiUrl, identityA.idToken);
    const transferQueryApiB = createTransferQueryApi(outputs.transferQueryApiUrl, identityB.idToken);
    const fromId = await openFreshAccount(commandApiA, queryApiA, "1000.00");
    const toId = await openFreshAccount(commandApiB, queryApiB, "0.00");
    const transferId = crypto.randomUUID();

    const startResponse = await transferCommandApi.start({
      transferId,
      fromAccountId: fromId,
      toAccountId: toId,
      amount: "300.00",
    });
    expect(startResponse.status).toBe(202);
    await waitForTransferState(transferQueryApiA, transferId, ["pending_confirmation"]);
    await transferCommandApi.confirm(transferId);
    await waitForTransferState(transferQueryApiA, transferId, ["credited"]);

    const inSenderList = await waitFor(
      async () => {
        const transfers = await transferQueryApiA.getMyTransfers();
        const matches = transfers.filter((t) => t.transferId === transferId);
        return matches.length > 0 ? matches : undefined;
      },
      { description: `transfer ${transferId} to appear in the sender's GET /customers/me/transfers` },
    );
    const inReceiverList = await waitFor(
      async () => {
        const transfers = await transferQueryApiB.getMyTransfers();
        const matches = transfers.filter((t) => t.transferId === transferId);
        return matches.length > 0 ? matches : undefined;
      },
      { description: `transfer ${transferId} to appear in the receiver's GET /customers/me/transfers` },
    );

    expect(inSenderList).toHaveLength(1);
    expect(inReceiverList).toHaveLength(1);
    expect(inSenderList[0].state).toBe("credited");
    expect(inReceiverList[0].state).toBe("credited");
  });
});

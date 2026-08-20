// Covers docs/adr/0028(サガの自己修復ウォッチドッグ)。[[0010-transfer-service-saga]]決定6は
// 「compensatingのまま滞留するケースへの対応は本ADRのスコープ外(自動リトライは設計しない)」
// としていたが、このシナリオはそれを実際に解決したことを実演する——単に「詰まったまま」を
// 確認して終わるのではなく、条件が解消した後にシステムが自律的に回復することまでを検証する。
//
// 「詰まった」状態そのものは`support/sagaState.ts`の`seedStuckCompensatingSaga`(実際の
// 分散システムのタイミングに依存する競合状態を避けるための、明示された裏口——コメント参照)
// で作るが、**回復そのもの(ウォッチドッグの直接invoke→account-serviceへの実際のコマンド
// 再送→実際の口座残高の変化→サガの状態遷移)は完全に実機のE2E検証**。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { REJECTION_SETTLE_MS, settle } from "../support/poll";
import { getWatchdogRetryCount, invokeSagaWatchdog, seedStuckCompensatingSaga } from "../support/sagaState";
import { openFreshAccount, waitForStatus } from "../support/testAccount";
import { trackCreatedTransfer } from "../support/testDataCleanup";
import { createTransferQueryApi, waitForTransferState } from "../support/transferClient";
import { signUpAndSignIn } from "../support/auth";

describe("docs/adr/0028: 恒久的に詰まったサガ(Compensating)は、条件解消後にウォッチドッグが自己修復する", () => {
  it("凍結中は再送しても詰まったまま(却下・再試行回数が増える)、凍結解除後は自動的にCompensatedへ進み残高が復元される", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identity.idToken);

    const accountId = await openFreshAccount(commandApi, queryApi, "1000.00");

    // R7が指す状態そのもの: 補償の入金先(この口座自身)が凍結中で、advance()が却下を
    // NextAction::Noneとして扱う設計(saga.rs)により、何もしなければ永久に止まる。
    const freezeResponse = await commandApi.freeze(accountId, "CustomerRequest");
    expect(freezeResponse.status).toBe(202);
    await waitForStatus(queryApi, accountId, "frozen");

    const transferId = crypto.randomUUID();
    await seedStuckCompensatingSaga(
      outputs.transferSagaTableName,
      { transferId, fromAccountId: accountId, ownerId: identity.sub, amount: "300.00" },
      1, // 1時間前 — ウォッチドッグのSTUCK_THRESHOLD(10分、saga_watchdog.rs)より十分に古い。
    );
    trackCreatedTransfer(transferId); // support/testDataCleanup.tsのteardownに乗せる。

    // transfer-status-projectorへの反映を待つ(DynamoDB Streamsは書き込み経路を問わず等しく
    // 発火するため、直接PutItemした後もこの投影が正常に働く、docs/adr/0012決定1)。
    const seeded = await waitForTransferState(transferQueryApi, transferId, ["compensating"]);
    expect(seeded.kind).toBe("furikae");
    expect(await getWatchdogRetryCount(outputs.transferSagaTableName, transferId)).toBe(0);

    // 1回目のスイープ: まだ口座が凍結中なので、再送された補償入金も却下される——
    // サガはCompensatingのまま(R7が本来ならここで永久に止まっていたはずの状態)。
    await invokeSagaWatchdog(outputs.transferSagaWatchdogFunctionName);
    await settle(REJECTION_SETTLE_MS);

    const stillStuck = await transferQueryApi.getTransferStatus(transferId);
    expect(stillStuck?.state).toBe("compensating");
    const stillFrozen = await queryApi.getAccount(accountId);
    expect(stillFrozen?.status).toBe("frozen");
    expect(await getWatchdogRetryCount(outputs.transferSagaTableName, transferId)).toBe(1);

    // 凍結を解除する——ここから先が「解決策を考えてこその知見」の核心: 条件さえ解消すれば、
    // 人手を介さずシステム自身が回復できることを実際に示す。
    const unfreezeResponse = await commandApi.unfreeze(accountId);
    expect(unfreezeResponse.status).toBe(202);
    await waitForStatus(queryApi, accountId, "active");

    // record_watchdog_retryはupdatedAtを更新しない(watchdogRetryCount/lastWatchdogAtだけを
    // 書く、persistence.rsのコメント参照)ため、backdateし直さなくても引き続き
    // STUCK_THRESHOLDより古いまま——2回目のスイープも同じサガを対象にする。
    await invokeSagaWatchdog(outputs.transferSagaWatchdogFunctionName);

    const recovered = await waitForTransferState(transferQueryApi, transferId, ["compensated"], { timeoutMs: 30_000 });
    expect(recovered.state).toBe("compensated");

    const finalView = await queryApi.getAccount(accountId);
    expect(Number(finalView?.balance)).toBe(1300.0); // 1000(初期) + 300(補償入金) = 資金は保存された。
  });
});

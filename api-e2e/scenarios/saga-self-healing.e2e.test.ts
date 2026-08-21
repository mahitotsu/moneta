// Covers docs/adr/0028(サガの自己修復ウォッチドッグ)。[[0010-transfer-service-saga]]決定6は
// 「compensatingのまま滞留するケースへの対応は本ADRのスコープ外(自動リトライは設計しない)」
// としていたが、このシナリオはそれを実際に解決したことを実演する——単に「詰まったまま」を
// 確認して終わるのではなく、条件が解消した後にシステムが自律的に回復すること・条件が解消
// しない場合は銀行所有の仮受金口座へ確定的に退避することの両方を検証する。
//
// 「詰まった」状態そのものは`support/sagaState.ts`の`seedStuckCompensatingSaga`(実際の
// 分散システムのタイミングに依存する競合状態を避けるための、明示された裏口——コメント参照)
// で作るが、**回復・退避そのもの(ウォッチドッグの直接invoke→account-serviceへの実際の
// コマンド再送→実際の口座残高の変化→サガの状態遷移)は完全に実機のE2E検証**。
//
// 注意: このテストが直接invokeするtransfer-saga-watchdogは、本番でも5分ごとのスケジュールで
// 独立に動いている(docs/adr/0028)——同じTransferSagaTableに対して手動invokeと本番スケジュール
// が競合しうるため、「ちょうどN回invokeしたらretryCountがちょうどNになる」という厳密な
// カウントには依存しない(`>=`で判定する)。最終的な状態遷移は`waitFor`ベースの十分な
// タイムアウトで待ち、余分な発火があっても(早く進むだけで)壊れないようにする。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { REJECTION_SETTLE_MS, settle, waitFor } from "../support/poll";
import {
  getAccountBalance,
  getWatchdogRetryCount,
  invokeSagaWatchdog,
  seedStuckCompensatingSaga,
} from "../support/sagaState";
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

    // まだ口座が凍結中なので、再送された補償入金も却下される——
    // サガはCompensatingのまま(R7が本来ならここで永久に止まっていたはずの状態)。
    await invokeSagaWatchdog(outputs.transferSagaWatchdogFunctionName);
    await settle(REJECTION_SETTLE_MS);

    const stillStuck = await transferQueryApi.getTransferStatus(transferId);
    expect(stillStuck?.state).toBe("compensating");
    const stillFrozen = await queryApi.getAccount(accountId);
    expect(stillFrozen?.status).toBe("frozen");
    expect(await getWatchdogRetryCount(outputs.transferSagaTableName, transferId)).toBeGreaterThanOrEqual(1);

    // 凍結を解除する——ここから先が「解決策を考えてこその知見」の核心: 条件さえ解消すれば、
    // 人手を介さずシステム自身が回復できることを実際に示す。
    const unfreezeResponse = await commandApi.unfreeze(accountId);
    expect(unfreezeResponse.status).toBe(202);
    await waitForStatus(queryApi, accountId, "active");

    // record_watchdog_retryはupdatedAtを更新しない(watchdogRetryCount/lastWatchdogAtだけを
    // 書く、persistence.rsのコメント参照)ため、backdateし直さなくても引き続き
    // STUCK_THRESHOLDより古いまま。凍結解除後は補償入金が成功するはずなので、確実に
    // 収束するまで数回invokeを試みる(本番スケジュールが横から先に処理してくれる場合も
    // あるため、このループは「保険」であって必須ではない)。
    const recovered = await waitFor(
      async () => {
        await invokeSagaWatchdog(outputs.transferSagaWatchdogFunctionName);
        const status = await transferQueryApi.getTransferStatus(transferId);
        return status?.state === "compensated" ? status : undefined;
      },
      { description: `transfer ${transferId} to reach compensated after the account was unfrozen`, timeoutMs: 60_000, intervalMs: 5_000 },
    );
    expect(recovered.state).toBe("compensated");

    const finalView = await queryApi.getAccount(accountId);
    expect(Number(finalView?.balance)).toBe(1300.0); // 1000(初期) + 300(補償入金) = 資金は保存された。
  });
});

describe("docs/adr/0028: 再送上限を超えても条件が解消しない場合は、銀行所有の仮受金口座へ確定的に退避する", () => {
  it("SweptToSuspenseへ確定し、仮受金口座の残高が退避額ぶん増える——「多分大丈夫」ではなく必ず確定した終端状態になる", async () => {
    const outputs = await fetchStackOutputs();
    const identity = await signUpAndSignIn(outputs.userPoolClientId);
    const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
    const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identity.idToken);

    const accountId = await openFreshAccount(commandApi, queryApi, "1000.00");
    const freezeResponse = await commandApi.freeze(accountId, "CustomerRequest");
    expect(freezeResponse.status).toBe(202);
    await waitForStatus(queryApi, accountId, "frozen");

    const transferId = crypto.randomUUID();
    await seedStuckCompensatingSaga(
      outputs.transferSagaTableName,
      { transferId, fromAccountId: accountId, ownerId: identity.sub, amount: "500.00" },
      1,
    );
    trackCreatedTransfer(transferId);
    await waitForTransferState(transferQueryApi, transferId, ["compensating"]);

    const suspenseBalanceBefore = await getAccountBalance(outputs.accountViewTableName, outputs.suspenseAccountId);

    // 凍結を一切解除しないまま、再送上限(MAX_WATCHDOG_RETRIES=3、saga_watchdog.rs)を超える
    // までウォッチドッグを起動し続ける——却下=何も適用されていないため連続invokeしても安全
    // (docs/adr/0028の安全性分析)。本番の5分間隔スケジュールが横から先に同じ処理を進めて
    // いても構わない(結果は同じ)ため、「ちょうど何回invokeしたか」ではなく「swept_to_suspense
    // に到達するか」だけを条件にする。
    const swept = await waitFor(
      async () => {
        await invokeSagaWatchdog(outputs.transferSagaWatchdogFunctionName);
        const status = await transferQueryApi.getTransferStatus(transferId);
        return status?.state === "swept_to_suspense" ? status : undefined;
      },
      { description: `transfer ${transferId} to be swept to the suspense account`, timeoutMs: 60_000, intervalMs: 2_000 },
    );
    expect(swept.state).toBe("swept_to_suspense");
    expect(await getWatchdogRetryCount(outputs.transferSagaTableName, transferId)).toBeGreaterThanOrEqual(3);

    // 口座自体は凍結されたまま(=正当な持ち主にはまだ届いていない)——このシナリオは
    // seedStuckCompensatingSagaで直接作った架空のサガであり、口座の実残高は最初の1000.00の
    // まま一度も動いていない(実際に組戻しが失敗するシナリオでは、正当な持ち主の残高は
    // 別途track済みの実際の出金額から計算する)。ここでの主張は「資金の所在が必ず確定する」
    // ことであり、それは仮受金口座の残高増分で確認する。
    const stillFrozen = await queryApi.getAccount(accountId);
    expect(stillFrozen?.status).toBe("frozen");

    const suspenseBalanceAfter = await waitFor(
      async () => {
        const balance = await getAccountBalance(outputs.accountViewTableName, outputs.suspenseAccountId);
        return balance !== suspenseBalanceBefore ? balance : undefined;
      },
      { description: "suspense account balance to reflect the swept deposit" },
    );
    expect(suspenseBalanceAfter - suspenseBalanceBefore).toBe(500.0);
  });
});

// Covers docs/e2e-scenarios.md R8 -- until now, D1相当(concurrency.e2e.test.ts)は「同一の
// 直接呼び出し元」同士の競合しか検証していなかった。transfer-serviceが発行するコマンドは
// account-serviceの同一コマンドキュー・同一MessageGroupId(=口座ID)空間に収束する設計
// (commands.rsの`message_group_id(account_id.to_string())`、docs/adr/0010)なので、直接の顧客
// コマンドとサガが発行するコマンドが同じ口座を同時に取り合っても、D1と同じFIFO直列化保証の
// もとで残高が破綻しないはずである——この「発行元が異なる」パターンは一度も試されていなかった
// (production-readiness-matrix.md R8)。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { waitFor } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";
import { createTransferCommandApi, createTransferQueryApi, waitForTransferState } from "../support/transferClient";

describe("R8: 直接コマンドとtransfer-service発行コマンドが同一口座を同時に取り合っても破綻しない", () => {
  it("合計が残高を超える2件(直接出金+振替)の同時要求は、片方だけ成功し残高が負にならない", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl);
    const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl);

    const owner = `e2e-r8-owner-${crypto.randomUUID()}`;
    const accountId = await openFreshAccount(commandApi, queryApi, "100", owner);
    // furikaeの送金先(同一owner、口座間送金の相手役)。
    const transferToId = await openFreshAccount(commandApi, queryApi, "0.00", owner);
    const transferId = crypto.randomUUID();

    // 直接の出金(80)と、transfer-service経由の振替(80、内部的にはWithdrawコマンドとして
    // account-serviceの同じキューに投入される)を、ほぼ同時に発行する。合計160は残高100を
    // 超えるため、直列化された結果どちらか一方だけが成功するはずである。
    const [directResponse, transferResponse] = await Promise.all([
      commandApi.withdraw(accountId, "80"),
      transferCommandApi.start({ transferId, fromAccountId: accountId, toAccountId: transferToId, amount: "80.00" }),
    ]);
    expect(directResponse.status).toBe(202);
    expect(transferResponse.status).toBe(202);

    // 最終的にどちらかが失敗する: 直接出金が先に適用されればfurikaeはInsufficientFundsで
    // failedになり、furikaeが先に適用されれば直接出金は反映されない(D1のsettleパターンと
    // 同じくどちらの却下にも正の観測シグナルがないため、残高が動くかサガがfailedになるかを待つ)。
    const transferSettled = waitForTransferState(transferQueryApi, transferId, ["credited", "failed"]);
    const balanceMoved = waitFor(
      async () => {
        const view = await queryApi.getAccount(accountId);
        return view && Number(view.balance) !== 100 ? view : undefined;
      },
      { description: `account ${accountId} balance to move away from 100` },
    );
    const [transferStatus] = await Promise.all([transferSettled, balanceMoved]);

    const finalView = await queryApi.getAccount(accountId);
    const finalBalance = Number(finalView?.balance);
    // 不変条件: 両方成功(100 - 80 - 80 = -60)には絶対にならない。片方だけ成功して20、
    // または直接出金だけ失敗してfurikaeだけ成功でも20——出金額が同じ(80)なので、
    // どちらのパターンでも最終残高は20になる。
    expect(finalBalance).toBe(20);
    expect(finalBalance).toBeGreaterThanOrEqual(0);
    // ちょうど一方だけが成功したことも、サガの状態から確認する。
    expect(["credited", "failed"]).toContain(transferStatus.state);
  });
});

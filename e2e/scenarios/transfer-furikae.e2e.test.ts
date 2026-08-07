// Covers docs/e2e-scenarios.md J1/J2/J3/J4/J7 (振替=同一名義間、docs/adr/0011)。
// 同一owner_idの2口座間の送金は`kind=furikae`と判定され、確認(J5/J6)を経由せず即座に
// 開始される(J7)——このファイルの全テストがその前提の上で書かれている。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { REJECTION_SETTLE_MS, settle, waitFor } from "../support/poll";
import { getSaga, waitForSagaState } from "../support/sagaState";
import { openFreshAccount } from "../support/testAccount";
import { startTransfer } from "../support/transferClient";

const OWNER = "e2e-furikae-owner";

describe("J1/J7: 振替(同一名義)は確認不要で即座に開始され、残高が反映される", () => {
  it("送金元が減り、送金先が同額増える", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const fromId = await openFreshAccount(commandApi, queryApi, "1000.00", OWNER);
    const toId = await openFreshAccount(commandApi, queryApi, "0.00", OWNER);
    const transferId = `e2e-furikae-${crypto.randomUUID()}`;

    await startTransfer(outputs.transferCommandQueueUrl, {
      transferId,
      fromAccountId: fromId,
      toAccountId: toId,
      amount: "300.00",
    });

    const saga = await waitForSagaState(outputs.transferSagaTableName, transferId, ["credited"]);
    expect(saga.kind).toBe("furikae");

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
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const fromId = await openFreshAccount(commandApi, queryApi, "100.00", OWNER);
    const toId = await openFreshAccount(commandApi, queryApi, "0.00", OWNER);
    const transferId = `e2e-furikae-insufficient-${crypto.randomUUID()}`;

    await startTransfer(outputs.transferCommandQueueUrl, {
      transferId,
      fromAccountId: fromId,
      toAccountId: toId,
      amount: "500.00",
    });

    const saga = await waitForSagaState(outputs.transferSagaTableName, transferId, ["failed"]);
    expect(saga.state).toBe("failed");

    const fromView = await queryApi.getAccount(fromId);
    const toView = await queryApi.getAccount(toId);
    expect(Number(fromView?.balance)).toBe(100.0);
    expect(Number(toView?.balance)).toBe(0.0);
  });
});

describe("J3: 送金先が入金を受け付けられない場合、送金元へ補償される", () => {
  it("送金先が凍結中だと、出金は成功するが最終的に送金元へ全額補償される", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const fromId = await openFreshAccount(commandApi, queryApi, "1000.00", OWNER);
    const toId = await openFreshAccount(commandApi, queryApi, "0.00", OWNER);

    const freezeResponse = await commandApi.freeze(toId, "CustomerRequest");
    expect(freezeResponse.status).toBe(202);
    await waitFor(
      async () => {
        const view = await queryApi.getAccount(toId);
        return view?.status === "frozen" ? view : undefined;
      },
      { description: `account ${toId} to become frozen` },
    );

    const transferId = `e2e-furikae-compensation-${crypto.randomUUID()}`;
    await startTransfer(outputs.transferCommandQueueUrl, {
      transferId,
      fromAccountId: fromId,
      toAccountId: toId,
      amount: "300.00",
    });

    const saga = await waitForSagaState(outputs.transferSagaTableName, transferId, ["compensated"]);
    expect(saga.state).toBe("compensated");

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
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const accountId = await openFreshAccount(commandApi, queryApi, "100.00", OWNER);
    const transferId = `e2e-furikae-same-account-${crypto.randomUUID()}`;

    await startTransfer(outputs.transferCommandQueueUrl, {
      transferId,
      fromAccountId: accountId,
      toAccountId: accountId,
      amount: "50.00",
    });

    // account-domainのDomainErrorと同様、決定論的な拒否には正の観測シグナルがない
    // (poll.tsの`settle`と同じ考え方)。SQS経由でも(account-serviceのようなoutboxを
    // 経由しないため)十分な時間待てば処理は終わっているはずである。
    await settle(REJECTION_SETTLE_MS);

    const saga = await getSaga(outputs.transferSagaTableName, transferId);
    expect(saga).toBeNull();

    const view = await queryApi.getAccount(accountId);
    expect(Number(view?.balance)).toBe(100.0);
  });
});

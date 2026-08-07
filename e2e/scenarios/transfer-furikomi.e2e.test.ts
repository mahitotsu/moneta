// Covers docs/e2e-scenarios.md J5/J6/J8 (振込=名義不一致、docs/adr/0011)。
// 送金元・送金先が異なるowner_idの2口座間の送金は`kind=furikomi`と判定され、確認
// (`Confirm`)が呼ばれるまでaccount-serviceには何も発行されない(J5)。確認後はfurikaeと
// 同じ経路で着金する(J6)。furikomi固有の上限額(J8)も併せて検証する。
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { REJECTION_SETTLE_MS, settle, waitFor } from "../support/poll";
import { getSaga, waitForOwnerIndexed, waitForSagaState } from "../support/sagaState";
import { openFreshAccount } from "../support/testAccount";
import { confirmTransfer, startTransfer } from "../support/transferClient";

// 送金元・送金先で異なる名義にするため、テストごとにユニークな2つのowner_idを使う
// (同じowner_idを複数テストで使い回すと、名義そのものは衝突しても実害はないが、
// 意図が読み取りにくくなるため避ける)。
function distinctOwners(): [string, string] {
  const suffix = crypto.randomUUID();
  return [`e2e-furikomi-owner-a-${suffix}`, `e2e-furikomi-owner-b-${suffix}`];
}

describe("J5/J6: 振込(名義不一致)は確認前は出金されず、確認すると着金する", () => {
  it("Startではpending_confirmationで停止し、Confirmで最終的に残高が反映される", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const [ownerA, ownerB] = distinctOwners();
    const fromId = await openFreshAccount(commandApi, queryApi, "1000.00", ownerA);
    const toId = await openFreshAccount(commandApi, queryApi, "0.00", ownerB);

    // 送金元・送金先双方の名義インデックスへの反映を待ってからStartする——反映前に送ると
    // command_intake.rs側でInfra扱いの再試行になり(docs/adr/0011)、テストが遅くなるだけで
    // 挙動としては同じだが、意図を明確にするため先に揃える。
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

    const transferId = `e2e-furikomi-${crypto.randomUUID()}`;
    await startTransfer(outputs.transferCommandQueueUrl, {
      transferId,
      fromAccountId: fromId,
      toAccountId: toId,
      amount: "300.00",
    });

    const pending = await waitForSagaState(outputs.transferSagaTableName, transferId, ["pending_confirmation"]);
    expect(pending.kind).toBe("furikomi");
    const fromBeforeConfirm = await queryApi.getAccount(fromId);
    const toBeforeConfirm = await queryApi.getAccount(toId);
    expect(Number(fromBeforeConfirm?.balance)).toBe(1000.0);
    expect(Number(toBeforeConfirm?.balance)).toBe(0.0);

    await confirmTransfer(outputs.transferCommandQueueUrl, transferId);

    const credited = await waitForSagaState(outputs.transferSagaTableName, transferId, ["credited"]);
    expect(credited.state).toBe("credited");
    await waitFor(
      async () => {
        const view = await queryApi.getAccount(fromId);
        return view && Number(view.balance) === 700 ? view : undefined;
      },
      { description: `account ${fromId} balance to reach 700 after confirmed furikomi` },
    );
    await waitFor(
      async () => {
        const view = await queryApi.getAccount(toId);
        return view && Number(view.balance) === 300 ? view : undefined;
      },
      { description: `account ${toId} balance to reach 300 after confirmed furikomi` },
    );
  });
});

describe("J8: 振込の上限額超過は受付時点で却下される", () => {
  it("サガは作成されず、残高も変化しない", async () => {
    const outputs = await fetchStackOutputs();
    const commandApi = createCommandApi(outputs.commandApiUrl);
    const queryApi = createQueryApi(outputs.queryApiUrl);
    const [ownerA, ownerB] = distinctOwners();
    const fromId = await openFreshAccount(commandApi, queryApi, "1000.00", ownerA);
    const toId = await openFreshAccount(commandApi, queryApi, "0.00", ownerB);
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, fromId);
    await waitForOwnerIndexed(outputs.transferAccountOwnersTableName, toId);

    const transferId = `e2e-furikomi-over-limit-${crypto.randomUUID()}`;
    // saga.rsのFURIKOMI_MAX_AMOUNT(1,000,000)を超える金額(docs/adr/0011決定4)。
    await startTransfer(outputs.transferCommandQueueUrl, {
      transferId,
      fromAccountId: fromId,
      toAccountId: toId,
      amount: "2000000.00",
    });

    await settle(REJECTION_SETTLE_MS);

    const saga = await getSaga(outputs.transferSagaTableName, transferId);
    expect(saga).toBeNull();
    const fromView = await queryApi.getAccount(fromId);
    expect(Number(fromView?.balance)).toBe(1000.0);
  });
});

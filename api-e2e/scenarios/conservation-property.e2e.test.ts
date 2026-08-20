// Covers docs/e2e-scenarios.md L1 -- 資金保存則。既存の全テスト(FC10-FC12・R1・R8等)は
// 「1口座」または「1組の送金ペア」単位の検証に閉じており、多数の口座・多数の操作が同時に
// 絡んでもシステム全体の合計金額が保存されることを検証する仕組みが一度もなかった
// (production-readiness-matrix.md L1、decision-tables.mdの議論)。
//
// 個別シナリオの積み上げではなく、ランダムな操作列を生成して不変条件を検証するプロパティ
// ベーステスト(fast-check)として実装する——これはこのプロジェクトのテスト戦略として初めて
// 導入する種類のテストである。
//
// スコープを絞るため、外部からの入出金(ATM入金/出金、これらは意図的にシステム全体の合計を
// 変える操作)は含めず、「同一名義の口座間の振替(furikae)だけで閉じた系」で検証する——
// furikaeは確認不要で即座に開始されるため(docs/adr/0011)、成功/失敗(残高不足)のどちらに
// 転んでも、この閉じた系の外にお金が漏れることはない。この閉じた系の中でどんな順序・組み合わせの
// 振替が発生しても、N口座の残高の合計は常に一定であるべきである。
import fc from "fast-check";
import { fetchStackOutputs } from "../support/stackOutputs";
import { createCommandApi, createQueryApi } from "../support/httpClient";
import { settle } from "../support/poll";
import { openFreshAccount } from "../support/testAccount";
import { createTransferCommandApi, createTransferQueryApi, waitForTransferState } from "../support/transferClient";
import { signUpAndSignIn } from "../support/auth";

const ACCOUNT_COUNT = 4;
const INITIAL_BALANCE_PER_ACCOUNT = 250;
const TOTAL = ACCOUNT_COUNT * INITIAL_BALANCE_PER_ACCOUNT;

// 口座ペア(from, to)と金額(0円は除く。account-domainのInvalidAmountで却下されるだけで、
// このプロパティの検証には寄与しないため)。
const transferArbitrary = fc.record({
  fromIndex: fc.integer({ min: 0, max: ACCOUNT_COUNT - 1 }),
  toIndex: fc.integer({ min: 0, max: ACCOUNT_COUNT - 1 }),
  amount: fc.integer({ min: 1, max: 100 }),
});

describe("L1: 資金保存則(同一名義口座間の振替が閉じた系の合計金額を変えない)", () => {
  it(
    "ランダムな振替の組み合わせを何度実行しても、N口座の残高合計は常に一定",
    async () => {
      const outputs = await fetchStackOutputs();
      // 全実行(numRuns)を通じて単一の識別子を使い回す——同一名義(furikae)であればよく、
      // 実行間で名義を分ける必要は元々owner文字列の可読性のためだけだった(docs/adr/0016決定3)。
      const identity = await signUpAndSignIn(outputs.userPoolClientId);
      const commandApi = createCommandApi(outputs.commandApiUrl, identity.idToken);
      const queryApi = createQueryApi(outputs.queryApiUrl, identity.idToken);
      const transferCommandApi = createTransferCommandApi(outputs.transferCommandApiUrl, identity.idToken);
      const transferQueryApi = createTransferQueryApi(outputs.transferQueryApiUrl, identity.idToken);

      await fc.assert(
        fc.asyncProperty(fc.array(transferArbitrary, { minLength: 5, maxLength: 15 }), async (transfers) => {
          const accountIds = await Promise.all(
            Array.from({ length: ACCOUNT_COUNT }, () =>
              openFreshAccount(commandApi, queryApi, String(INITIAL_BALANCE_PER_ACCOUNT)),
            ),
          );

          // 同一口座への送金(fromIndex === toIndex)はSameAccountとして要求時点で却下される
          // (FC10)ため、そのケースは事前に除外して無駄な待ちを避ける。
          const validTransfers = transfers.filter((t) => t.fromIndex !== t.toIndex);

          // 順不同で同時に発行する(R1/R8と同じ精神: 直列化の結果として個々の失敗はあっても、
          // 系全体の合計は保存されるはず)。
          const results = await Promise.all(
            validTransfers.map(async (t) => {
              const transferId = crypto.randomUUID();
              await transferCommandApi.start({
                transferId,
                fromAccountId: accountIds[t.fromIndex],
                toAccountId: accountIds[t.toIndex],
                amount: String(t.amount),
              });
              return transferId;
            }),
          );

          // 全ての送金が終端状態(credited/failed)に達するまで待つ。
          await Promise.all(
            results.map((transferId) => waitForTransferState(transferQueryApi, transferId, ["credited", "failed"])),
          );
          // 反映待ちの読み取りラグ(結果整合性)を吸収するための追加の安定待ち。
          await settle();

          const balances = await Promise.all(accountIds.map((id) => queryApi.getAccount(id)));
          const total = balances.reduce((sum, view) => sum + Number(view?.balance ?? NaN), 0);

          expect(total).toBe(TOTAL);
        }),
        { numRuns: 5, timeout: 180_000 }, // 実行が高コスト(実AWS呼び出し)なため試行回数は控えめにする。
      );
    },
    // docs/adr/0027: query-serviceの各イベント処理がownerId解決のため追加のDynamoDB Query
    // (Opened以外のイベント)を1回持つようになり、結果整合性の反映がわずかに遅くなった
    // ——このテストは多数の操作を連続実行するため、その遅れが積み重なって元の600秒ちょうどで
    // 実際にタイムアウトすることを2026-08-20に実機で確認した(値そのものの誤りではなく、
    // 検証結果の反映待ちが間に合わなかっただけ)。900秒に拡大。
    900_000,
  );
});

# E2Eテスト

`docs/e2e-scenarios.md` に記載したシナリオの自動化。ADRが主張する外部から観測可能な性質
(結果整合性の遅延窓、OCC競合時の直列化、ドメインエラーの却下、冪等性)を、デプロイ済みの
実AWS環境(コマンドAPI/照会API)に対して実際にHTTPリクエストを送って検証する。

## 前提

- `MonetaAccountPipelineStack`(`infra/support/stackOutputs.ts`のSTACK_NAME/REGION)が
  ap-northeast-1にデプロイ済みであること。
- 実行環境にそのスタックを呼び出せるAWS認証情報が設定されていること
  (`CommandApiUrl`/`QueryApiUrl`等をCloudFormationのDescribeStacksで解決する)。
- ローカルにAurora DSQLの正確なエミュレーションが存在しないため、このE2Eはローカル
  スタック(LocalStack等)ではなく実デプロイ環境に対してのみ実行する前提としている。

## 実行方法

```bash
cd infra
npm run test:e2e
```

`npm test`(CDK synthテスト、`infra/test/`)とは別のJest設定(`e2e/jest.config.js`)を
使う。実AWS環境を叩き、結果整合性待ちのシナリオは1件あたり最大150秒程度かかるため、通常の
`npm test`には含めていない。

**`--maxWorkers=3`を外さないこと。** outbox relay(`AccountOutboxRelayFunction`,
`infra/lib/account-pipeline-stack.ts`)はタイムアウト30秒・EventBridge Schedulerで1分に
1回だけ起動する、容量が固定されたPoC規模のLambdaである。シナリオファイル数が増えた際に
Jestのデフォルト並列度(CPU数に応じて自動)で実行したところ、ほぼ全ての結果整合性待ちの
シナリオ(単純なA1すら)が90秒でタイムアウトした——テストスイート自身が生む同時書き込みの
バーストが、この固定容量のリレーを詰まらせたと考えられる。ワーカー数を絞ることで、
テストスイートが自らその場しのぎのボトルネックを作らないようにしている。

## テストの独立性(クリーンアップ不要)

口座IDはクライアント生成(ADR-0006決定2)であるため、各テストは`crypto.randomUUID()`で
毎回新しい口座を使う。これによりテスト間の依存やクリーンアップは不要で、`clean-data.ts`
(`infra/scripts/`)を都度実行する必要はない。`clean-data.ts`は開発中のDSQL/DynamoDBの
データ量を定期的にリセットする運用スクリプトという位置づけのまま残し、E2E実行の前提には
していない。

## シナリオ対応表

| シナリオID | ファイル | 状態 |
|---|---|---|
| A1 | `scenarios/open-account.e2e.test.ts` | 実装済み |
| A2/A4, A3/A5 | `scenarios/deposit-withdraw.e2e.test.ts` | 実装済み(バックエンド視点ではA2=A4、A3=A5。UI固有の差異は下記「未実装」参照) |
| A6, B2, B7 | `scenarios/domain-errors-frozen-account.e2e.test.ts`(Frozen口座1つを共有) | 実装済み |
| A7 | `scenarios/unfreeze-lifecycle.e2e.test.ts` | 実装済み(専用フィクスチャ、4連続待ちのためタイムアウト720秒) |
| A8, B3 | `scenarios/domain-errors-closed-account.e2e.test.ts`(Closed口座1つを共有) | 実装済み |
| A9 | `scenarios/transaction-history.e2e.test.ts` | 実装済み |
| B1, B5, B6, B8 | `scenarios/domain-errors-active-account.e2e.test.ts`(Active口座1つを共有) | 実装済み |
| B4 | `scenarios/domain-errors-not-found.e2e.test.ts` | 実装済み |
| C1, C2 | `scenarios/idempotency.e2e.test.ts` | 実装済み |
| C3 | `scenarios/idempotency-distinct-keys.e2e.test.ts` | 実装済み |
| D1 | `scenarios/concurrency.e2e.test.ts` | 実装済み |
| D2 | `scenarios/concurrency-volume.e2e.test.ts` | 実装済み |
| E1 | `scenarios/group-independence.e2e.test.ts` | 実装済み(不正accountIdをinfra失敗として利用した近似。真のHOLブロッキング再現はI1同様、障害注入が要る) |
| F1 | `scenarios/eventual-consistency.e2e.test.ts` | 実装済み |
| F2 | `scenarios/transaction-history-lag.e2e.test.ts` | 実装済み |
| G1, G2, G3 | `scenarios/input-validation.e2e.test.ts` | 実装済み |
| G4 | `scenarios/known-gap-malformed-account-id.e2e.test.ts` | 実装済み(既知のギャップの固定化。DLQへの到達を確認後、そのメッセージだけを削除する) |
| A4/A5のUI固有部分(顧客セッションと無関係であること・表示用ラベルがバックエンドに送られないこと)、F3、H1-H3 | (未実装) | このハーネスは生HTTP呼び出しのみで、実際のWeb UI(ブラウザ)は駆動していない。ブラウザ自動化(Playwright等)が別途必要 — `docs/e2e-scenarios.md`参照 |
| I1 | (未実装、手動確認のみ) | 持続的なインフラ障害の再現にはフォルトインジェクション(実環境への意図的な障害注入)が要り、このPoCの規模には過大。デプロイ済み環境に対する破壊的操作を伴うため、自動化するなら別途合意が必要 |

## 実装上の注意

- `support/httpClient.ts`はWeb UI(`web-ui/src/api/`)と同じワイヤーフォーマットを別途
  定義したもの(コード共有はしていない — infra/web-uiは独立したTSプロジェクトのため)。
  バックエンドの契約を変更したら両方を追随させる必要がある。
- ドメインエラー(却下)は照会APIに反映されない(ADR-0002、却下通知は将来の
  Notification service待ち)。そのため却下系シナリオ(B, `support/poll.ts`の`settle`)は
  「一定時間、状態が変化しないこと」を確認する形になっており、収束を待つ肯定的シナリオ
  (`waitFor`)とは検証の型が異なる。
- 却下系シナリオはどれも定義上「状態を変えない」ため、同じ前提条件(Active/Frozen等)を
  必要とする複数シナリオは`beforeAll`で1つのフィクスチャ口座を共有してよい
  (`domain-errors-active-account.e2e.test.ts`/`domain-errors-frozen-account.e2e.test.ts`)。
  開設・凍結・解約のたびに発生する結果整合性待ち(最大約150秒、ADR-0004+負荷時のマージン)を、シナリオの数だけ
  重複して払わずに済む。ファイルもシナリオのグループごとに分けているのは、Jestがテスト
  ファイル単位でしか並列実行しない(1ファイル内の`it`は直列実行される)ため。新しい却下系
  シナリオを追加する際は、既存のフィクスチャ(Active/Frozen)を使い回せないか先に検討する。

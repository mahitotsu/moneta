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
使う。実AWS環境を叩くため、通常の`npm test`には含めていない。

**outbox relayの直接Invokeによる高速化(`support/relay.ts`)。** outbox relay
(`AccountOutboxRelayFunction`)は本番ではEventBridge Schedulerで1分に1回だけ起動する
(ADR-0004)。この1分という値はEventBridgeのrate式の仕様上のハード下限であり、本番の
アーキテクチャ・コスト方針を変えずに縮めることはできない。そこで**本番のスケジュールは
一切変更せず**、`support/poll.ts`の`waitFor`はデフォルトでポーリングの毎回、outbox relay
Lambdaを直接Invokeする(`relay_once`はイベントの中身を見ないため、呼び出し元を問わない)。
これにより、大半のシナリオの待ち時間は1分間隔ではなくrelayの実行時間程度まで縮む。

**例外はF1/F2だけ。** ADR-0004の主張は「最大約1分」という**上限**であり、正確な自然発生の
遅延時間を測定する必要はない——何秒で収束したかに関わらず、上限内に収束しさえすれば主張は
満たされる。`triggerRelay: false`(`scenarios/eventual-consistency.e2e.test.ts`/
`scenarios/transaction-history-lag.e2e.test.ts`)が防いでいるのは「F1/F2自身がrelayを
叩いて自分の成功を作り出してしまう(自己成就的なテストになる)」ことだけである。

`relay_once`は呼び出し元を問わず未発行の行を全部処理するため、他のシナリオファイルと
並行実行すると、他のテストが自分のポーリングで起こしたrelayのInvokeに、F1/F2のイベントも
ついでに乗って発行されることがある(実際、フルスイート実行でF1/F2が数秒〜十数秒で終わる
ことがある)。これは合否判定上まったく問題ない——「誰かが偶然relayを起こしてくれて上限内に
収束した」も「上限約1分以内に収束する」という主張の反証にはならない。F1/F2が保証している
のは「収束すること」「中間状態が壊れていないこと」「タイムアウト(上限)を超えて放置され
ないこと」であり、収束にかかった正確な秒数そのものではないため、他のテストとの並行実行は
問題にならない。

新しいシナリオを追加する際、待ちが「上限内に収束するかどうか」の検証でない限りは、
デフォルトの加速(`triggerRelay`を指定しない)のままでよい。

**`--maxWorkers=3`について。** シナリオファイル数が増えた際にJestのデフォルト並列度
(CPU数に応じて自動)で実行したところ、テストスイート自身が生む同時書き込みのバーストが
1分間隔の固定容量リレーを詰まらせ、ほぼ全てのシナリオがタイムアウトしたことがあった
(relay直接Invoke導入前の話)。直接Invoke導入後はこの詰まりは起きにくくなっているはずだが、
`--maxWorkers`を上げる場合は一度様子を見ながら行うこと。

## テストの独立性(クリーンアップ不要)

口座IDはクライアント生成(ADR-0006決定2)であるため、各テストは`crypto.randomUUID()`で
毎回新しい口座を使う。これによりテスト間の依存やクリーンアップは不要で、`clean-data.ts`
(`infra/scripts/`)を都度実行する必要はない。`clean-data.ts`は開発中のDSQL/DynamoDBの
データ量を定期的にリセットする運用スクリプトという位置づけのまま残し、E2E実行の前提には
していない。

**例外はDLQに到達するシナリオ(G4・E1)。** これらは意図的に持続的なインフラ失敗を起こす
ため、後片付けしないとDLQにメッセージが実行のたびに溜まり続け、ADR-0002決定6のCloudWatch
アラームにいずれ影響しうる。`support/dlq.ts`の`waitForMatchingMessage`で該当メッセージを
確認後に削除しており(他のメッセージには触れない)、新しくDLQ行きのシナリオを追加する際は
同じ後片付けが必須になる。

## シナリオ対応表

| シナリオID | ファイル | 状態 |
|---|---|---|
| A1 | `scenarios/open-account.e2e.test.ts` | 実装済み |
| A2/A4, A3/A5 | `scenarios/deposit-withdraw.e2e.test.ts` | 実装済み(バックエンド視点ではA2=A4、A3=A5。UI固有の差異は下記「未実装」参照) |
| A6, B2, B7 | `scenarios/domain-errors-frozen-account.e2e.test.ts`(Frozen口座1つを共有) | 実装済み |
| A7 | `scenarios/unfreeze-lifecycle.e2e.test.ts` | 実装済み(専用フィクスチャ、4連続待ちのためタイムアウト240秒) |
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
| F3 | `web-ui/src/components/AccountView.test.tsx`(このinfra/e2eではなくweb-ui側、Vitest+React Testing Library) | 実装済み(表示ロジックの主張であり、実AWS環境やブラウザ自動化を要さずコンポーネント単体で検証できるため、このハーネスとは別建て) |
| A4/A5のUI固有部分(顧客セッションと無関係であること・表示用ラベルがバックエンドに送られないこと)、H1-H3 | (未実装) | このハーネスは生HTTP呼び出しのみで、実際のWeb UI(ブラウザ)は駆動していない。ブラウザ自動化(Playwright等)が別途必要 — `docs/e2e-scenarios.md`参照 |
| I1 | (未実装、手動確認のみ) | 持続的なインフラ障害の再現にはフォルトインジェクション(実環境への意図的な障害注入)が要り、このPoCの規模には過大。デプロイ済み環境に対する破壊的操作を伴うため、自動化するなら別途合意が必要 |
| J1, J2, J7 | `scenarios/transfer-furikae.e2e.test.ts` | 実装済み(docs/adr/0011。同一owner_idの2口座間送金=furikaeとして、確認不要の即時開始・残高反映・残高不足を検証) |
| J3 | `scenarios/transfer-furikae.e2e.test.ts` | 実装済み(送金先を凍結した状態でfurikaeを実行し、補償まで確認) |
| J4 | `scenarios/transfer-furikae.e2e.test.ts` | 実装済み(却下系のため`settle`パターン、Bカテゴリと同じ考え方) |
| J5, J6 | `scenarios/transfer-furikomi.e2e.test.ts` | 実装済み(異なるowner_idの2口座間送金=furikomiとして、`Confirm`前後の状態を検証) |
| J8 | `scenarios/transfer-furikomi.e2e.test.ts` | 実装済み(却下系。上限額超過はStart時点で却下されサガが作られない) |
| J9 | `scenarios/transfer-recall.e2e.test.ts` | 実装済み(credited直後=時間窓内でのrecallを検証、実時間待ちは不要) |
| J10 | `scenarios/transfer-recall.e2e.test.ts` | 実装済み(残高不足パターンは操作のみで再現可能。期限超過パターンは`support/sagaState.ts`の`backdateSagaUpdatedAt`で`updatedAt`を直接書き換えて模擬——実時間24時間待つ代わりの、この検証専用の裏口) |

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
  開設・凍結・解約のたびに発生する結果整合性待ち(relay直接Invokeで通常は数秒〜数十秒、
  詰まった場合の上限は150秒)を、シナリオの数だけ重複して払わずに済む。ファイルもシナリオの
  グループごとに分けているのは、Jestがテスト
  ファイル単位でしか並列実行しない(1ファイル内の`it`は直列実行される)ため。新しい却下系
  シナリオを追加する際は、既存のフィクスチャ(Active/Frozen)を使い回せないか先に検討する。
- **Transfer service(J、docs/adr/0010・0011)は顧客向けAPI Gatewayがまだ無く、受付が
  Transfer受付キューへの直接`SendMessage`のみ**(ADR-0010決定6)。`support/transferClient.ts`
  が`httpClient.ts`のHTTPラッパーと同じ役割をSQS向けに提供する(`TransferCommand`の
  `Start`/`Confirm`/`Cancel`/`Recall`)。サガ状態はDynamoDB(`moneta-transfer-sagas`)に
  あり照会APIが無いため、`support/sagaState.ts`の`waitForSagaState`/`getSaga`が直接
  `GetItem`する——`waitFor`(`support/poll.ts`)を内部で再利用しているため、outbox relay
  直接Invokeによる加速も自動的に効く(account.event.OpenedやWithdrawn/Depositedの発行が
  outbox経由なのはaccount-serviceの他のイベントと同じ)。furikae/furikomiの判定も同じ
  outbox発行に依存する口座名義インデックス(`moneta-transfer-account-owners`)の反映待ちが
  要るため、`waitForOwnerIndexed`も同様に`waitFor`を再利用する。
- **組戻し(recall)の時間窓(J10、24時間)は実時間を待たずに検証する。**
  `recall_eligibility`(saga.rs)は`now`を明示的な引数に取る純粋関数なのでユニットテストは
  元々実時間非依存だが、この実デプロイE2Eでも同様に、`support/sagaState.ts`の
  `backdateSagaUpdatedAt`でサガの`updatedAt`を直接過去へ書き換えることで期限切れを模擬する。
  アプリケーションの通常の書き込み経路(`advance_saga_state`のCAS)を経由しない、この検証
  専用の裏口であることを明示するため、他のヘルパーとは違う直接`UpdateItem`という形にして
  ある(`support/dlq.ts`がDLQを直接操作するのと同じ位置づけ)。

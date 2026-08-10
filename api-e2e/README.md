# E2Eテスト

`docs/e2e-scenarios.md` に記載したシナリオの自動化。ADRが主張する外部から観測可能な性質
(結果整合性の遅延窓、OCC競合時の直列化、ドメインエラーの却下、冪等性)を、デプロイ済みの
実AWS環境(コマンドAPI/照会API)に対して実際にHTTPリクエストを送って検証する。

## 前提

- `MonetaAccountPipelineStack`(`support/stackOutputs.ts`のSTACK_NAME/REGION)が
  ap-northeast-1にデプロイ済みであること。
- 実行環境にそのスタックを呼び出せるAWS認証情報が設定されていること
  (`CommandApiUrl`/`QueryApiUrl`等をCloudFormationのDescribeStacksで解決する)。
- API GatewayのVTL直接統合・CloudFront・DynamoDB Streamsの実際の配信タイミングをローカルで
  正確にエミュレートする手段がないため、このE2Eはローカルスタック(LocalStack等)ではなく
  実デプロイ環境に対してのみ実行する前提としている。

このディレクトリは`infra`/`web-ui`と同じく独立したTSプロジェクト(自前の`package.json`)
であり、CDKアプリそのもの(`infra/`)には依存しない——デプロイ済みスタックのCloudFormation
出力を読むだけなので、依存を持ち込む必然性がない(`support/stackOutputs.ts`は
`infra/support/stackOutputs.ts`と役割が重複するが、あえて別々に持つ。理由は後述)。

## 実行方法

**このE2Eは「デプロイ済みのスタックの実際の挙動」を検証するものであり、手元のソース
コードそのものを検証するものではない。** `crates/`や`infra/lib/`を変更した後は、必ず先に
デプロイし直すこと——デプロイし忘れたまま実行すると、変更前の古いLambdaコードを検証して
「テストが通った/落ちた」という誤った結果を得ることになる。

```bash
cd infra && npm run deploy   # 1. 最新のソースをデプロイする(変更が無ければ`npm run diff`で
                              #    「差分なし」を確認するだけでもよい)
cd ../api-e2e && npm install # 2. 初回のみ(依存関係を自前で持つ独立パッケージのため)
npm test                     # 3. 今デプロイされている断面に対して検証する
```

`infra`の`npm test`(CDK synthテスト、`infra/test/`)とは別プロジェクト・別Jest設定
(`jest.config.js`)。実AWS環境を叩くため、CDK synthテストの延長では実行しない。

**加速用のフックは不要になった(docs/adr/0013)。** account-serviceの永続化はAurora DSQLから
DynamoDBへ移行し、アウトボックスもEventBridge Schedulerの1分間隔ポーリング
(`AccountOutboxRelayFunction`)ではなく、`account_events`テーブルのDynamoDB Streamsが
`AccountOutboxProjectorFunction`を直接トリガーする方式に変わった(ADR-0004・0013)。
これにより結果整合性の反映は近リアルタイム(概ね秒未満〜数秒)になり、かつて存在した
「relay Lambdaを直接Invokeして1分間隔のポーリングを迂回する」加速フック(`support/relay.ts`、
`waitFor`の`triggerRelay`オプション)は不要になったため削除した。P1
(`scenarios/eventual-consistency.e2e.test.ts`/`scenarios/transaction-history-lag.e2e.test.ts`)
がかつて`triggerRelay: false`で行っていた「自己成就的なテストにしない」という配慮も、
加速フック自体が無くなったことで自動的に成立する。

`support/poll.ts`の`waitFor`は既定で30秒のタイムアウト・1秒間隔でポーリングする
(`DEFAULT_TIMEOUT_MS`/`DEFAULT_INTERVAL_MS`)。実測値は実行のたびに変わりうるため、
正確な収束時間を主張に組み込みたい場合は実行結果を都度確認すること。

## テストの独立性(クリーンアップ不要)

口座IDはクライアント生成(ADR-0006決定2)であるため、各テストは`crypto.randomUUID()`で
毎回新しい口座を使う。これによりテスト間の依存やクリーンアップは不要で、`clean-data.ts`
(`infra/scripts/`)を都度実行する必要はない。`clean-data.ts`は開発中のDynamoDBの
データ量を定期的にリセットする運用スクリプトという位置づけのまま残し、E2E実行の前提には
していない。

**例外はDLQに到達するシナリオ(FC8・R5)。** これらは意図的に持続的なインフラ失敗を起こす
ため、後片付けしないとDLQにメッセージが実行のたびに溜まり続ける(ADR-0002決定6が構想する
CloudWatchアラームは`docs/production-readiness-matrix.md` O1の通り未実装だが、それとは無関係に
DLQ自体は放置すべきではない)。`support/dlq.ts`の`waitForMatchingMessage`で該当メッセージを
確認後に削除しており(他のメッセージには触れない)、新しくDLQ行きのシナリオを追加する際は
同じ後片付けが必須になる。

## シナリオ対応表

シナリオIDは[docs/production-readiness-matrix.md](../docs/production-readiness-matrix.md)の行ID
(`FC#`/`R#`/`O#`/`S#`/`P#`/`E#`/`L#`)。2026-08-10、旧A〜Jのアルファベット割り当てから移行した
(対応関係は各行の「旧」表記、または`docs/e2e-scenarios.md`側に記載)。

| シナリオID | ファイル | 状態 |
|---|---|---|
| FC1 | `scenarios/open-account.e2e.test.ts`, `scenarios/domain-errors-not-found.e2e.test.ts`, `scenarios/domain-errors-active-account.e2e.test.ts`(重複ID部分) | 実装済み |
| FC2/FC3 | `scenarios/deposit-withdraw.e2e.test.ts` | 実装済み(バックエンド視点では入金経路/出金経路それぞれ1本。UI固有の差異は下記「未実装」参照) |
| FC4 | `scenarios/domain-errors-frozen-account.e2e.test.ts`(Frozen口座1つを共有)、`scenarios/unfreeze-lifecycle.e2e.test.ts`(専用フィクスチャ、4連続待ちのためタイムアウト240秒)、`scenarios/domain-errors-active-account.e2e.test.ts`(既にActiveへのUnfreeze部分) | 実装済み |
| FC5 | `scenarios/domain-errors-closed-account.e2e.test.ts`(Closed口座1つを共有) | 実装済み |
| FC6 | `scenarios/transaction-history.e2e.test.ts` | 実装済み |
| FC3(残高不足) | `scenarios/domain-errors-active-account.e2e.test.ts`(Active口座1つを共有) | 実装済み |
| E1(冪等性) | `scenarios/idempotency.e2e.test.ts`, `scenarios/idempotency-distinct-keys.e2e.test.ts` | 実装済み |
| R1 | `scenarios/concurrency.e2e.test.ts`, `scenarios/concurrency-volume.e2e.test.ts` | 実装済み(FIFO順序保証下での正しさのみを証明。R2のOCCリトライ自体は未証明、下記参照) |
| R5 | `scenarios/group-independence.e2e.test.ts` | 実装済み(不正accountIdをinfra失敗として利用した近似。真のHOLブロッキング再現はR4同様、障害注入が要る) |
| P1 | `scenarios/eventual-consistency.e2e.test.ts`, `scenarios/transaction-history-lag.e2e.test.ts` | 実装済み |
| FC7 | `scenarios/input-validation.e2e.test.ts` | 実装済み(金額精度境界`10.123`のようなケースは未実装、下記参照) |
| FC8 | `scenarios/known-gap-malformed-account-id.e2e.test.ts` | 実装済み(既知のギャップの固定化。DLQへの到達を確認後、そのメッセージだけを削除する) |
| E7 | `web-ui/src/components/AccountView.test.tsx`(このapi-e2eではなくweb-ui側、Vitest+React Testing Library) | 実装済み(表示ロジックの主張であり、実AWS環境やブラウザ自動化を要さずコンポーネント単体で検証できるため、このハーネスとは別建て) |
| FC10/FC11/FC12のUI固有部分(振替/振込画面の状態遷移・確認/取消/組戻しボタン) | `ui-e2e/scenarios/*.spec.ts` | 実装済み(`docs/adr/0014`)。このハーネスは生HTTP呼び出しのみで実際のWeb UI(ブラウザ)は駆動していないため、`ui-e2e/`という別のトップレベルパッケージ(Playwright、ヘッドレスChromium)で検証する |
| FC2/FC3のUI固有部分(顧客セッションと無関係であること・表示用ラベルがバックエンドに送られないこと)、FC9 | (未実装) | `ui-e2e/`と同じ枠組みで追加できるが、`docs/adr/0014`時点ではTransfer service(振替/振込)の検証を優先し未着手 |
| R4 | (未実装、手動確認のみ) | 持続的なインフラ障害の再現にはフォルトインジェクション(実環境への意図的な障害注入)が要り、このPoCの規模には過大。デプロイ済み環境に対する破壊的操作を伴うため、自動化するなら別途合意が必要 |
| FC10 | `scenarios/transfer-furikae.e2e.test.ts` | 実装済み(docs/adr/0011。同一owner_idの2口座間送金=furikaeとして、確認不要の即時開始・残高反映・残高不足を検証) |
| R6 | `scenarios/transfer-furikae.e2e.test.ts` | 実装済み(送金先を凍結した状態でfurikaeを実行し、補償まで確認) |
| FC10(同一口座却下) | `scenarios/transfer-furikae.e2e.test.ts` | 実装済み(却下系のため`settle`パターン、FCカテゴリ全体と同じ考え方) |
| FC11 | `scenarios/transfer-furikomi.e2e.test.ts` | 実装済み(異なるowner_idの2口座間送金=furikomiとして、`Confirm`前後の状態・上限額超過での却下を検証) |
| FC12 | `scenarios/transfer-recall.e2e.test.ts` | 実装済み(credited直後=時間窓内でのrecallと、残高不足・期限超過パターンを検証。期限超過は`support/sagaState.ts`の`backdateSagaUpdatedAt`で`updatedAt`を直接書き換えて模擬——実時間24時間待つ代わりの、この検証専用の裏口) |

**`docs/production-readiness-matrix.md`で🔴/🟡・未実装と判定された主要項目**(この表にファイルが
存在しないもの): R2(OCCリトライの回復)・R3(SQS再配信の成功パス)・R8(複数発行元の同時競合)・
R9(スロットリング/接続断)・O1(DLQアラーム)・O2(業務メトリクス)・S4(敵対的input耐性)・
P2/P3(流量特性)・E2(順序逆転の意図的検証)・L1(資金保存則)・L2/L3(監査ログの完全性・改ざん
不可能性)・L6(突合)・FC13(transfer-serviceの`NonPositiveAmount`/精度境界)。詳細と優先度は
`docs/e2e-scenarios.md`を参照。

## 実装上の注意

- `support/httpClient.ts`はWeb UI(`web-ui/src/api/`)と同じワイヤーフォーマットを別途
  定義したもの(コード共有はしていない — api-e2e/web-uiは独立したTSプロジェクトのため)。
  バックエンドの契約を変更したら両方を追随させる必要がある。
- `support/stackOutputs.ts`は`infra/support/stackOutputs.ts`(`clean-data.ts`が使う)と
  ほぼ同一の内容を意図的に複製している。CloudFormationの`DescribeStacks`を叩くだけの
  数十行のために、CDKアプリ本体の依存(`aws-cdk`/`aws-cdk-lib`/`constructs`等)ごと
  infraパッケージにこのE2Eをぶら下げるのは本末転倒——query-service/transfer-serviceが
  account-serviceに直接依存せず公開インターフェース越しにしか触らない設計(ADR-0008、
  ADR-0010)と同じ考え方で、小さな重複を許容してでも境界を独立させている。
- ドメインエラー(却下)は照会APIに反映されない(ADR-0002、却下通知は将来の
  Notification service待ち)。そのため却下系シナリオ(B, `support/poll.ts`の`settle`)は
  「一定時間、状態が変化しないこと」を確認する形になっており、収束を待つ肯定的シナリオ
  (`waitFor`)とは検証の型が異なる。
- 却下系シナリオはどれも定義上「状態を変えない」ため、同じ前提条件(Active/Frozen等)を
  必要とする複数シナリオは`beforeAll`で1つのフィクスチャ口座を共有してよい
  (`domain-errors-active-account.e2e.test.ts`/`domain-errors-frozen-account.e2e.test.ts`)。
  開設・凍結・解約のたびに発生する結果整合性待ち(DynamoDB Streams駆動で通常は数秒、
  `waitFor`の既定タイムアウトは30秒)を、シナリオの数だけ重複して払わずに済む。ファイルもシナリオの
  グループごとに分けているのは、Jestがテスト
  ファイル単位でしか並列実行しない(1ファイル内の`it`は直列実行される)ため。新しい却下系
  シナリオを追加する際は、既存のフィクスチャ(Active/Frozen)を使い回せないか先に検討する。
- **Transfer service(J、docs/adr/0010・0011)は顧客向けAPI Gatewayがまだ無く、受付が
  Transfer受付キューへの直接`SendMessage`のみ**(ADR-0010決定6)。`support/transferClient.ts`
  が`httpClient.ts`のHTTPラッパーと同じ役割をSQS向けに提供する(`TransferCommand`の
  `Start`/`Confirm`/`Cancel`/`Recall`)。サガ状態はDynamoDB(`moneta-transfer-sagas`)に
  あり照会APIが無いため、`support/sagaState.ts`の`waitForSagaState`/`getSaga`が直接
  `GetItem`する——`waitFor`(`support/poll.ts`)を内部で再利用している(account.event.Opened
  やWithdrawn/Depositedの発行がoutbox経由なのはaccount-serviceの他のイベントと同じ)。
  furikae/furikomiの判定も同じoutbox発行に依存する口座名義インデックス
  (`moneta-transfer-account-owners`)の反映待ちが要るため、`waitForOwnerIndexed`も同様に
  `waitFor`を再利用する。
- **組戻し(recall)の時間窓(FC12、24時間)は実時間を待たずに検証する。**
  `recall_eligibility`(saga.rs)は`now`を明示的な引数に取る純粋関数なのでユニットテストは
  元々実時間非依存だが、この実デプロイE2Eでも同様に、`support/sagaState.ts`の
  `backdateSagaUpdatedAt`でサガの`updatedAt`を直接過去へ書き換えることで期限切れを模擬する。
  アプリケーションの通常の書き込み経路(`advance_saga_state`のCAS)を経由しない、この検証
  専用の裏口であることを明示するため、他のヘルパーとは違う直接`UpdateItem`という形にして
  ある(`support/dlq.ts`がDLQを直接操作するのと同じ位置づけ)。

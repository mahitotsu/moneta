# ADR 0024: 振込手数料とポイント — fee-service/points-serviceの新設とtransfer-serviceからのオーケストレーション

## ステータス

Accepted。`crates/fee-service`(新規)・`crates/points-service`(新規)・`crates/transfer-service`の
`saga.rs`/`commands.rs`/`persistence.rs`/`bin/command_intake.rs`/`bin/saga_step.rs`・
`infra/lib/account-pipeline-stack.ts`のFee/Points serviceセクション、いずれも実装済み。
`cargo test --workspace`(全テストgreen)・`cargo clippy --workspace --all-targets`(警告ゼロ)・
`infra`の`npm test`(CDK synth、42件全合格)で確認済み。2026-08-17、デプロイ後に既存の
`api-e2e`(振込・組戻しシナリオ)を実行し、実デプロイでしか見つからない不具合を1件発見・修正
した:`bin/saga_step.rs`の`issue_action`が`NextAction::IssueWithdraw`を`unreachable!()`のまま
残していたため(`reserve_fee_observed`がこの経路で新たに`IssueWithdraw`を返すようになった
ことをこの1箇所だけ反映し忘れていた)、`ReservingFee`→`PendingDebit`遷移のたびにLambdaが
panicし、全ての振込がタイムアウトしていた。修正・再デプロイ後、`transfer-furikomi`/
`transfer-recall`とも全件合格を確認した。

振込の残高計算に伴い、既存の`api-e2e`シナリオ(`transfer-furikomi.e2e.test.ts`・
`transfer-recall.e2e.test.ts`)のうち手数料導入前の期待残高を固定していたテストを更新した。
特に**組戻し(recall)は元のfurikomiで徴収された手数料を返金しない**という設計判断(送金額
(300円)だけを組戻し、220円の手数料は組戻し後も送金元に残る)を今回のセッションで確定した
——決定2の「組戻し自体は手数料を課さない」は「新しい組戻し取引に新しい手数料を乗せない」
という意味であり、「元の取引の手数料を遡って取り消す」ことまでは意味しない、と明文化する。
実際の銀行慣行(振込手数料は取消後も非返金であるのが一般的)にも合致し、組戻しのサガが元の
`transfer_id`の手数料予約に踏み込む新しい結合を持ち込まずに済む(`0011`決定5の「組戻しは
新しい終端状態を追加しない」というシンプルさを保つ)。

`account-service`/`query-service`/`account-domain`への変更は無い。

**別件(同session、本ADRの決定ではないが記録に値する)**: `api-e2e/support/httpClient.ts`の
`deposit`/`withdraw`ヘルパーが`[[0023-transaction-channel-provenance]]`で`channel`が必須に
なった後も追随しておらず、19シナリオファイルに影響する既存の潜在バグを発見・修正した
(`channel`引数を追加し、既定値`"Atm"`を持たせた)。修正後、`api-e2e`フルスイート
(25スイート・49テスト)は48件即時合格、残り1件(`conservation-property.e2e.test.ts`、
furikaeのみを使う資金保存則のプロパティベーステストで手数料機能とは無関係)は並列実行時の
リソース競合により600秒のタイムアウトぎりぎりで超過しただけと判明——単独実行では約101秒で
合格することを確認済み。

## コンテキスト

口座管理・振込・振替(`0011`)に続く増分として、「デジタルデータ/ITを活用したネットバンキング
らしいサービス」というテーマで、①振込(`Furikomi`)にのみ手数料を課す、②送金時の入金(振込受取)
額に応じてポイントを付与する、③手数料をポイントで自動充当する、の3機能を検討した。

検討の過程で、当初案(手数料を「送金成功後に独立した`Withdraw`で徴収する」設計)には、徴収時点で
送金元の残高が既に別の操作で減っている場合に手数料の徴収そのものが失敗しうるという弱点が
見つかった。この弱点を解消する方法として「送金額と手数料をまとめて1回の出金にし、原資を
確保してから送金処理を進める」という案を検討し、この骨格自体は本ADRでも維持している(決定4)。

サービス境界については当初「手数料計算とポイント台帳を1つのサービス(`rewards-service`)に
統合する」案を検討したが、これは「手数料の設計」と「ポイント台帳」を別々の、独立して成長しうる
関心事として扱うべきだという指摘により再検討した。「手数料サービスがポイントサービスの内情を
知っているのは不自然」という指摘は正しく、`transfer-service`↔`account-service`と同じ
コマンド/イベント契約を1段重ねるだけで解消できることが分かった——以下の設計はこの整理に基づく。

**注記**: 「手数料設計はそれだけで1チームが必要な業務規模である」という組織論的な理由づけは、
本プロジェクトの憲章([CLAUDE.md](../../CLAUDE.md)「Project context」)が明示的にスコープ外と
する組織的リアリズムに該当するため、本ADRの決定の根拠には採らない。代わりに、以下の技術的な
理由(境界づけられたコンテキストとしての独立性、サガの入れ子構成としての一般性の実証)を採用の
根拠とする。

## 決定

### 1. `rewards-service`を`fee-service`(手数料ポリシー)と`points-service`(ポイント台帳)に分割する。いずれも直接の上位・下位サービス以外を知らない独立クレートとする

- `points-service`: 誰も知らない末端。`account-domain`にも他の新設サービスにも依存しない。
  ポイント残高の増減だけを扱う。
- `fee-service`: 手数料ポリシー(金額決定ロジック、ポイント充当の可否判断)を所有する。
  `points-service`を**利用**する(SQSコマンド送信/EventBridgeイベント購読)が、Cargoの
  コンパイル依存は持たない。`account-domain`にも`account-service`にも一切依存しない・
  一切話しかけない。
- `transfer-service`: `fee-service`を**利用**する。同じく`fee-service`へのコンパイル依存は
  追加しない。

`transfer-service`→`fee-service`→`points-service`という一方向の利用の連鎖になる。上流は下流の
コマンド/イベント契約(語彙)だけを知り、下流の永続化スキーマや内部状態には一切踏み込まない——
`transfer-service`が`account-service`をSQS/EventBridge越しにしか触らない([[0010-transfer-service-saga]]
決定1)のと同じ境界を、この連鎖のどの隣接ペアにも適用する。

### 2. 手数料の「金額」自体も`fee-service`の内部ロジックとする。`transfer-service`は金額を知らない

`transfer-service`は`ReserveFee { transfer_id, owner_id: from_owner_id, account_id: from_account_id, transfer_amount }`
を送るだけで、手数料の具体的な金額は一切渡さない・知らない。`fee-service`内部の
`fee_for(transfer_amount) -> Decimal`が金額を決定する(v1では固定額`FURIKOMI_FEE_AMOUNT`=220円を
仮の値とする)。振替(`Furikae`)・組戻し(`Recall`)には`transfer-service`がそもそも`ReserveFee`を
送らないため、`fee-service`はこの2種別の存在を知る必要すらない。

将来のステージ別割引・免除(ユーザー提案のロードマップ)は、`fee_for`が顧客属性を追加で参照する
よう`fee-service`内部だけで拡張できる——`transfer-service`側の変更は不要という設計になっている。

### 3. ポイント予約(`ReservePoints`)は拒否しない設計にする。不足分は必ずcashPortionとして返す

`points-service`は`ReservePoints { owner_id, up_to }`を受け取ると、`PointsTable`から
`min(保有ポイント, up_to)`を条件付きで原子的に減算し、`PointsReserved { points_used }`を
(アウトボックス経由で)返すだけで、**この処理自体が「拒否」を返すことはない**——保有ポイントが
0でも`points_used = 0`として常に成功する。

`fee-service`はこれを受けて`cash_portion = fee_amount - points_used`を計算し、
`FeeReserved { cash_portion }`を`transfer-service`へ返す。これも拒否しない——「原資が足りずに
手数料確保そのものが失敗する」という状態遷移は、旧設計と同じくどの層の状態機械にも一切
追加しない。実際に口座残高が(送金額+現金負担分の手数料)を賄えるかは、決定4の通り
`transfer-service`の既存の`PendingDebit`残高チェックが一括して検証する。

### 4. 送金元への出金は「送金額+現金負担分の手数料」を1回の`Withdraw`で行う(前回設計を維持)

`TransferSaga`に`cash_fee: Decimal`(既定`ZERO`)・`from_owner_id`/`to_owner_id: String`を追加する
(前回設計にあった`points_used`フィールドは不要になった——理由は決定6)。`SagaState`に新しい
状態`ReservingFee`を追加し、振込のサガは以下のように進む(振替・組戻しは一切変更なし、
`cash_fee`は常に`ZERO`のまま今まで通り`PendingDebit`から始まる)。

```
PendingConfirmation --confirm--> ReservingFee --(FeeReserved観測)--> PendingDebit(amount+cash_fee)
    --(Withdrawn)--> PendingCredit --(Deposited)--> Credited [+ AwardPoints発行、決定7]
```

- `confirm()`: 振込の場合、`ReservingFee`+新しい
  `NextAction::IssueReserveFee { transfer_id, owner_id: from_owner_id, account_id: from_account_id, transfer_amount: saga.amount }`
  を返すよう変更する(`fee_amount`を渡さないことが決定2の帰結)。
- 新しい関数`reserve_fee_observed(saga, cash_fee, now)`: `ReservingFee`のサガに対してのみ
  呼ばれ、`saga.cash_fee`をセットした上で`PendingDebit`+
  `NextAction::IssueWithdraw { account_id: from_account_id, amount: saga.amount + cash_fee }`
  を返す。
- `PendingCredit`が却下された場合の補償(`IssueCompensatingDeposit`)も、送金元を完全に元通りに
  するため`amount + saga.cash_fee`を返す。

送金先への入金額(`IssueDeposit`)は`saga.amount`のまま変更しない。手数料そのもの(現金分)が
どこにも入金されない(銀行の収益口座のような着地先を持たない)点は、`C1`/`C2`(コスト最適化)と
同じ理由でスコープ外とする。

### 5. `fee-service`は自分専用の予約台帳(`FeeReservationsTable`)を持ち、`points-service`とのやり取りの状態を自分の中だけで完結させる

`FeeReservationsTable`(DynamoDB、PK=`transfer_id`)に`{ transfer_id, owner_id, fee_amount, points_used, state }`
を持つ。`fee-service`の`command_intake`相当のLambdaは`ReserveFee`受信時にこの表へ
`AwaitingPointsReservation`状態で書き込み、`points-service`へ`ReservePoints`を送る。
`saga_step`相当のLambda(EventBridge駆動)は`points.event.PointsReserved`を観測すると
`cash_portion`を計算して`Reserved`へ進め、`fee.event.FeeReserved`を発行する。

`RefundFee { transfer_id }`(決定7)を受けたときは、この表から`transfer_id`を引いて
`points_used`を取り出し、`points-service`へ`RefundPoints { owner_id, amount: points_used }`を
送るだけでよい——`transfer-service`は`points_used`の値を一切覚えておく必要がない(決定4で
`TransferSaga`から`points_used`フィールドを削った理由)。`points_used`が0(=全額現金で
賄われていた)場合は`RefundPoints`自体を送らない。

`points-service`側も対称に、`RewardsPointsTable`(前回案の名称を踏襲、PK=`owner_id`)への
`UpdateItem`のみで完結する。

### 6. 予約系(`ReservePoints`→`PointsReserved`、`ReserveFee`→`FeeReserved`)だけがアウトボックスを持つ。返却・付与系はfire-and-forget

決定3までの設計を通して見ると、次の規則が3層(`account-service`を含む)すべてに一貫して
成り立つことが分かった。

> **呼び出し元がその結果を見て次の判断をする(=待つ)コマンドの応答だけが、DynamoDB
> Streamsアウトボックス([[0004-query-service-event-driven-projection]])を経由してイベント発行
> される。呼び出し元が結果を待たない(=fire-and-forgetでよい)コマンドは、アウトボックスを
> 経由しない単純な`UpdateItem`で済ませる。**

- `ReservePoints`→`PointsReserved`(`fee-service`が待つ)、`ReserveFee`→`FeeReserved`
  (`transfer-service`が待つ): アウトボックスを持つ。
- `RefundPoints`・`RefundFee`・`AwardPoints`: 誰も結果を待たないため、アウトボックスを
  経由しない。決定5の通り、失敗時の返却は「補償が失敗し続けるケースは運用アラートに委ねる」
  という[[0010-transfer-service-saga]]の既存トレードオフと同種の割り切りとする。

### 7. ポイント付与(`AwardPoints`)は`transfer-service`から`points-service`へ直接発行する。`fee-service`を経由しない

`PendingCredit`が成功した場合(`Credited`へ遷移)、`saga.kind == Furikomi`であれば追加で
`NextAction::IssueAwardPoints { owner_id: to_owner_id, amount: award_points_for(saga.amount) }`を
`points-service`へ直接発行する(`fee-service`は一切関与しない——付与は手数料とは独立した
関心事であるため)。`award_points_for`は`amount`の0.1%を仮の付与率とする固定関数。振替・組戻しは
決定2と同じ理由(自分の口座間の往復で無限にポイントを稼げる経路を作らないため)で対象外とする。

失敗時の返却(決定5の`RefundFee`→`RefundPoints`)も同様に、`transfer-service`は`fee-service`だけを
呼び、`points-service`を直接は呼ばない——ポイントの「原資としての消費」を仲介したのが
`fee-service`である以上、その巻き戻しも`fee-service`が責任を持つ。

### 8. EventBridgeの`detailType`命名規約と、既存Ruleへの相乗り

`account.event.*`/`account.rejection.*`/`auth.event.*`(`0016`)に倣い、`fee.event.FeeReserved`・
`points.event.PointsReserved`という命名を使う。各サービスの観測用Lambdaは、自分が実際に
待つ`detailType`だけを`eventPattern`でフィルタする新しいEventBridge Ruleを持つ
(`FeeServicePointsObservationRule`が`points.event.PointsReserved`を、既存の
`TransferSagaObservationRule`が`fee.event.FeeReserved`を追加で購読する)——`points.event.*`は
`transfer-service`側のRuleには含めない。

新しいSQSキューは`FeeCommandQueue`(`transfer-service`→`fee-service`)・
`PointsCommandQueue`(`fee-service`/`transfer-service`→`points-service`、決定7の通り両方から
送られる)の2つを新設する。いずれも`TransferCommandQueue`と同じ形(FIFO、
`MessageGroupId = owner_id`)にする。

## トレードオフ

- **3層(transfer→fee→points)のオーケストレーションになり、往復のホップが増える**: 単一
  サービスに統合する案(前回の設計)より結果整合性の窓が一段長くなる。ただし各ホップは
  既存の`account.event.*`観測と同じ規模の遅延(アウトボックスの最大約1分)であり、
  `[[0010-transfer-service-saga]]`の「複数ステップの合計になる」というトレードオフの延長で
  説明できる。
- **`ReservePoints`/`ReserveFee`に却下を設けないことの裏返し**(決定3、前回から変更なし):
  「ポイントと現金を合わせても手数料を払えない」という状況は区別せず、常に現金側で埋める。
  実際に払えるかは`PendingDebit`の残高不足チェックが一括して判定する。
- **返却・付与系はアウトボックスを経由しない**(決定6): `RefundFee`/`RefundPoints`/
  `AwardPoints`は、`account_events`テーブル(`0004`)のような追記専用の監査ログ・完全性保証
  ([L2]/[L3]、`docs/production-readiness-matrix.md`)を持たない。
- **手数料・付与率・換算レートはすべて固定定数**: 顧客のステージやステータスに応じた
  割引・優遇レートは本ADRの範囲では実装しない。ただし決定2の通り、これらはすべて
  `fee-service`/`points-service`の内部だけで完結する拡張になるよう設計してある——「顧客の
  ステージ」というデータ自体がまだこのシステムのどこにも存在しない点が、次の増分で改めて
  設計が必要な理由である。
- **顧客向けUI(手数料・ポイント残高の表示)は本ADRのスコープ外**: `[[0011-furikae-furikomi-distinction]]`
  や`[[0010-transfer-service-saga]]`決定6と同じ据え置き方針を踏襲し、バックエンドのサガ拡張
  のみを対象とする。

## 却下した代替案

- **手数料計算とポイント台帳を1つのサービス(`rewards-service`)に統合する**: 「原資確保→進める」
  という問題は`fee-service`↔`points-service`間に一段ずれて再発するように見えたが、実際には
  `transfer-service`↔`account-service`と同じコマンド/イベント契約を1段重ねるだけで解決でき、
  統合する技術的必然性はなかった。手数料ポリシーとポイント台帳という異なる関心事を無理に
  同居させるより、独立して進化できる2サービスに分ける方が[[0003-domain-service-crate-boundary]]の
  境界哲学に忠実であるため、分割案を採用した。
- **手数料を送金成功後に独立した`Withdraw`で徴収する**: 徴収時点で残高が別の操作により既に
  減っている場合に失敗しうるため不採用(決定4で解消)。
- **`fee-service`/`points-service`が`account-service`へ直接`Withdraw`/`Deposit`する**: 現金負担分を
  `transfer-service`自身の既存の`Withdraw`/補償`Deposit`に合算する設計(決定4)の方が、
  `fee-service`/`points-service`のどちらも`account-service`の存在を一切知らずに済み、
  相関ID設計の衝突リスクも生まれないため不採用。
- **手数料返却用に新しい終端状態(`RefundingFee`等)を`SagaState`に追加する**: `RefundFee`を
  fire-and-forgetにする設計(決定6)により、`transfer-service`の状態遷移を1つも増やさずに
  済むため不要。

## 次のステップ

実装・デプロイ・E2E検証まですべて完了済み:

1. ✅ `crates/points-service`(`ledger.rs`: `reserve`/`credit`)——単体テスト6件
2. ✅ `crates/fee-service`(`reservation.rs`: `fee_for`/`start`/`points_reserved`/`refund`)——単体
   テスト7件
3. ✅ `crates/transfer-service`の`saga.rs`(`ReservingFee`状態、`reserve_fee_observed`、`advance`の
   拡張、`TransferSaga`への`from_owner_id`/`to_owner_id`/`cash_fee`追加)・`persistence.rs`
   (`advance_saga_to_pending_debit_with_fee`)・`commands.rs`(`send_reserve_fee`/`send_refund_fee`/
   `send_award_points`)・`bin/command_intake.rs`/`bin/saga_step.rs`のLambda glue——単体テスト36件、
   `cargo test --workspace`/`cargo clippy --workspace --all-targets`とも green

4. ✅ `crates/points-service`のLambda glue: `bin/command_intake.rs`(`ReservePoints`/
   `RefundPoints`/`AwardPoints`、楽観ロックのリトライ付き)・`bin/outbox_projector.rs`
   (`points.event.PointsReserved`)・`persistence.rs`(`PointsTable`、冪等性ログ、決定6の
   アウトボックス)
5. ✅ `crates/fee-service`のLambda glue: `bin/command_intake.rs`(`ReserveFee`/`RefundFee`)・
   `bin/points_observation.rs`(`points.event.PointsReserved`の観測、`transfer-service`の
   `bin/saga_step.rs`と同型)・`bin/outbox_projector.rs`(`fee.event.FeeReserved`)・
   `persistence.rs`(`FeeReservationsTable`)・`commands.rs`(`points-service`宛のコマンド送信)。
   実装中に発見した重要な事実(CLAUDE.mdの「AWS/ライブラリの挙動は仮定せず確認する」を適用):
   `time`クレートの`serde-human-readable`は`OffsetDateTime`を**RFC3339ではなく独自の空白区切り
   形式**でシリアライズする(`time-0.3.54`のソースで確認)。`account_domain::EventEnvelope`
   (`transfer-service`が`fee.event.FeeReserved`のパースに使う型)の`occurred_at`はこの形式を
   要求するため、`fee-service`の`outbox_projector.rs`はRFC3339文字列を手組みするのではなく、
   DynamoDBから読んだ値を一度`OffsetDateTime`に戻し、`account_domain::EventEnvelope`と同形の
   ローカル構造体(`account-domainには依存しないが同じ`time`クレートを使う)を介して
   `serde_json`にシリアライズさせることで形式を一致させている。

6. ✅ `infra/lib/account-pipeline-stack.ts`: `FeeCommandQueue`/`PointsCommandQueue`(それぞれ
   DLQ+CloudWatchアラーム込み)、`PointsTable`/`PointsEventsTable`/`PointsIdempotencyTable`/
   `FeeReservationsTable`/`FeeEventsTable`、5つの新規Lambda(`points-command-intake`/
   `points-outbox-projector`/`fee-command-intake`/`fee-points-observation`/
   `fee-outbox-projector`)、`FeePointsObservationRule`(新規)、既存の
   `TransferSagaObservationRule`への`fee-service`ソース追加、IAM(`transferCommandIntakeFn`/
   `transferSagaStepFn`への既存定義ブロックを書き換えない追記——`.addEnvironment()`/
   `grantSendMessages()`を後段で呼ぶ形)。`infra/test/account-pipeline-stack.test.ts`の
   Lambda数(15→20)・DynamoDBテーブル一覧・CloudWatchアラーム数(4→8)・
   `TransferSagaObservationRule`のsource配列を検証するテストを合わせて更新し、
   account-service専用のTransactWriteItems回帰テストがpoints-service/fee-serviceの
   同種の権限を誤って数えないよう実行ロール単位に絞り込んだ。`npm test`(CDK synth、
   42件全合格)で確認済み。

7. ✅ `api-e2e`シナリオの追加(`scenarios/transfer-fee-and-points.e2e.test.ts`、新規)。
   `transfer-furikomi.e2e.test.ts`/`transfer-recall.e2e.test.ts`は保有ポイント0(現金全額
   負担)のケースしか検証していなかったギャップを埋める3シナリオ:
   - 振込の着金でポイントが付与される(決定7、送金額の0.1%)
   - 保有ポイントで手数料の一部を充当できる(決定3・4、100pt保有→220円の手数料のうち
     100ptを充当、残り120円だけ現金負担)
   - 送金が失敗した場合、消費したポイントは全額返却される(決定5、`FeeReservationsTable`が
     `refunded`へ遷移することも直接確認)
   照会APIを持たない`PointsTable`/`FeeReservationsTable`への直接アクセスは新設の
   `support/pointsState.ts`(`support/sagaState.ts`と同じ「裏口ではなく妥当な検証手段」という
   位置づけ)で行う。実デプロイ済みスタックに対して3件とも一発で合格を確認した(2026-08-18)。
   これにより、ステータス節で触れた「`api-e2e`フルスイートは手数料導入前の期待値のまま」
   というギャップ(保有ポイント0のケースしか通っていなかった)も解消済み。

# ADR 0028: サガの自己修復ウォッチドッグ

## ステータス

Accepted。`crates/transfer-service`(`src/saga.rs`の`resume_action`、`src/persistence.rs`の
`scan_stuck_sagas`/`record_watchdog_retry`、新規`src/bin/saga_watchdog.rs`)・
`infra/lib/account-pipeline-stack.ts`(`TransferSagaWatchdogFunction`・スケジュール駆動の
`events.Rule`・`StuckSagaEscalatedAlarm`)に実装する。`cargo test`/`cargo clippy`(全crate、
警告0件)・`infra`のCDK synth(50件、新規4件を含む)はgreen。デプロイ後、
`api-e2e`(`scenarios/saga-self-healing.e2e.test.ts`)をライブスタックに対して実行し、
「詰まる→再送しても詰まったまま→条件解消→再送で回復」までを実機で確認する(検証結果は
このセクションを更新する)。

## コンテキスト

[[0010-transfer-service-saga]]決定6は「`Compensating`のまま滞留するケースへの対応は本ADRの
スコープ外(自動リトライやDLQ的な仕組みは設計しない、運用上のアラート・手動対応を前提とする)」
と明記していた。`docs/production-readiness-matrix.md`のR7・`docs/decision-tables.md`はこれを
既知のギャップとして記録するに留めていた。

このギャップを「詰まったままのシナリオを実演するテストを追加する」ことで消化しようとしたところ、
それでは`docs/insights.md`に足す新しい知見にならない(既知の事実の再確認に過ぎない)という
指摘を受けた。本ADRは、実際に**イベント駆動の枠内で自己修復を設計・実装・検証する**ことに
取り組んだ結果である。

## 決定

### 1. スケジュール駆動(タイマー)の新しいLambdaとして実装する。既存のLambda(`saga_step.rs`/
`command_intake.rs`)には手を入れない

`saga_step.rs`(イベント駆動)・`command_intake.rs`(SQS駆動)はどちらも「何かが届いたら反応する」
設計であり、「一定時間、期待していたイベントが届かない」という**不在**を検知することは原理的に
できない——不在はタイマーでしか検知できない。`crates/transfer-service/src/bin/saga_watchdog.rs`
を、`infra`側でEventBridgeのレート指定スケジュール(5分ごと)から起動する新しいLambdaとして
追加する。既存の2つのLambdaの実装・トリガーは無変更のまま——[[0004-query-service-event-driven-projection]]/[[0010]]以来一貫している「新しい関心事は既存のコード・トリガーを変更せず、
新しいLambda/トリガーとして追加する」という増分の作法をそのまま踏襲する。

### 2. 再送するコマンドは新しいロジックではなく、既存の状態遷移ロジックの「再現」

`saga.rs`に`resume_action(saga: &TransferSaga) -> NextAction`を追加する。`expected_step`
(状態→「待っているイベント」)と対になる、状態→「詰まっている場合に再発行すべきコマンド」の
マッピングで、`ReservingFee`/`PendingDebit`/`PendingCredit`/`Compensating`の4状態それぞれに
対し、`confirm`/`reserve_fee_observed`/`advance`が各状態への遷移時に**既に一度計算して
発行したのと同じ形の`NextAction`**を、保存済みの`TransferSaga`(`cash_fee`等、遷移時点で
確定した値を保持している)から再構成するだけである。単体テストで、実際に各遷移関数を呼んで
得られる`NextAction`と`resume_action`が同じ状態に対して返す`NextAction`が一致することを
直接突き合わせて検証している。

### 3. 安全性分析: 単純な再送は、SQS FIFOの重複排除窓(5分)を過ぎると二重適用を防げない
——しかし、このシステムが実際にさらす詰まり方に対しては十分安全

`crates/transfer-service/src/commands.rs`の`send_command`は`MessageDeduplicationId`に
`{correlation_id}-{action}`という決定論的な値を使っている([[0010]]決定5)。しかしSQS FIFOの
重複排除は**5分間の窓に限定される**([AWS公式ドキュメント](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html)で確認済み:
"a 5 minute minimum deduplication interval"、窓を過ぎた重複は検知されないと明記)。さらに
account-serviceの冪等性ログ(`crates/account-service/src/handler.rs`)はSQSが配信ごとに
新規発行する`message.message_id`をキーにしており、`MessageDeduplicationId`の中身ではない。
つまり**5分を過ぎてからの単純な再送は、コマンドが実際に適用済みだった場合に二重適用を
防げない**——これがADR-0010が当初「自動リトライは設計しない」とした背景にあるリスクだと
推測できる。

しかし、サガが実際に詰まる典型的な原因を分解すると、このリスクの大きさは限定的である:

1. **CAS成功後・コマンド発行前にLambdaが落ちた**(コマンドは一度も送られていない)——
   再送は初回の送信そのものであり安全。
2. **補償の入金が却下され続けている**(例: 送金元口座が凍結中)——`advance`は`Compensating`
   状態での却下を`NextAction::None`(無反応)として扱う設計になっており、これがR7の実体
   そのもの。却下=何も適用されていない、なので再送は安全。
3. **コマンドは成功したが結果イベントが永久に失われた**——account-serviceのアウトボックスは
   `TransactWriteItems`で状態変更とイベント記録を原子的に行い([[0004]]/[[0013-migrate-account-service-off-aurora-dsql]])、DynamoDB Streams起点で再試行される設計のため、「永久に
   失われる」事象はこのシステムの結果整合性の窓(通常最大約1分)よりはるかに長い、O1のDLQ
   アラームが先に発報するレベルの持続的障害でしか起こらない。

ウォッチドッグの発火閾値(`STUCK_THRESHOLD` = 10分)を、通常の結果整合性の窓より十分長く
取ることで、ケース3が実際に問題になる確率は無視できるレベルまで下がる——**完全な正確さ
(exactly-onceの形式的な保証)は諦め、このPoCが実際にさらす障害モードに対して十分安全な
設計を選ぶ**、という意図的なトレードオフである。

### 4. 再送回数に上限を設け、超えたらCloudWatchメトリクスで運用者へ引き継ぐ

`MAX_WATCHDOG_RETRIES`(3回)を超えても解消しないサガは、それ以上再送せず
`Moneta/TransferSaga`名前空間の`StuckSagaEscalated`カスタムメトリクス(dimension `State`)を
発行する。O1(DLQアラーム、`addDlqAlarms`)と同じ「1件でも見えたら発報」という保守的な閾値の
`StuckSagaEscalatedAlarm`がこれを監視する——[[0010]]決定6が最初に構想していた「運用上の
アラート・手動対応」を、今回初めて実装する形。自動リトライで解消できない詰まり
(例: 口座が解約されたまま二度と戻らない)は、この段階で人間の判断に委ねる。

### 5. 再送回数・最終再送時刻はサガのドメイン構造体には持たせない

`watchdogRetryCount`/`lastWatchdogAt`は`TransferSaga`(`saga.rs`)には追加せず、
`persistence.rs`がウォッチドッグ専用の生のDynamoDB属性として直接読み書きする
(`scan_stuck_sagas`/`record_watchdog_retry`)。運用上のブックキーピングをピュアな状態機械の
モデルに混ぜない、という判断——`correlation_id`/`channel`を「輸送のみの関心事」として
`EventEnvelope`に持たせつつ`Event`/`Command`には持たせない([[0010]]決定4、
[[0023-transaction-channel-provenance]])のと同じ切り分けを踏襲する。

### 6. スキャン+条件付き更新による安全な再送

`scan_stuck_sagas`はPoC規模のテーブルサイズを前提に、対象4状態への`FilterExpression`付き
フルスキャンで詰まっている候補を列挙する(`infra/scripts/backfill-item-owners.ts`と同じ
「PoC規模ではスキャンで十分」という割り切り)。再送後の`record_watchdog_retry`は、スキャン
時点の`state`と`updatedAt`が変化していないことを`ConditionExpression`で確認してから
`watchdogRetryCount`を書く(`advance_saga_state`と同じCASパターン)——スキャンと実際の
コマンド発行の間にサガが通常の観測経路で自然に先へ進んでいた場合、古い情報に基づく不要な
再送を防ぐ。

## トレードオフ

- **決定3の安全性分析は、形式的な証明ではなく確率的な議論である**——完全なexactly-once保証
  ではなく、「このシステムが実際にさらす障害モード」に対する十分性の判断に留まる。
  account-serviceの冪等性キー戦略自体を変える(却下した代替案参照)方がより厳密な保証を
  得られるが、そのコストに見合わないと判断した。
- **フルスキャンはPoC規模でのみ妥当**——サガの件数が増えれば、この設計はスキャンコストの
  観点でスケールしない。`updatedAt`にGSIを張る等の改善余地はあるが、この記事の主張
  (イベント駆動な自己修復の実証)には寄与しないため見送った。
- **5分間隔のスケジュールは、詰まりの検知に最大5分+`STUCK_THRESHOLD`(10分)の遅延を持つ**——
  即応性より運用コスト(実行頻度)を優先した設計判断。

## 却下した代替案

- **account-serviceの冪等性キー戦略を、SQSが配信ごとに発行する`message_id`から
  `MessageDeduplicationId`の中身へ変更する**: これによりウォッチドッグの再送を任意の時間差で
  安全にできるようになるが、account-service(このPoCが「新サービスは既存サービスを一切
  変更せず追加できる」ことを繰り返し実証してきた、まさにその対象)自体の変更を要求する。
  この記事の中心的主張を崩してまで得る価値は無いと判断した。
- **完全な突合(reconciliation)ベースのexactly-once配信**: 再送前に対象口座の現在状態を
  問い合わせ、コマンドが本当に未適用かを確認してから送る設計。形式的にはより厳密だが、
  PoCの規模に対して明らかに過大(それ自体が独立した検証テーマになりうる)であり、決定3の
  確率的な安全性で十分と判断した。
- **`Compensating`だけを対象にする(R7が指す状態に限定する)**: 詰まる根本原因
  (CAS成功後・コマンド発行前のLambdaクラッシュ)は`ReservingFee`/`PendingDebit`/
  `PendingCredit`にも等しく起こりうるため、1つの状態だけを特別扱いする理由がない。
  `expected_step`が`Some`を返す4状態全てに一般化する方が、1つの仕組みで済み設計として
  一貫する。

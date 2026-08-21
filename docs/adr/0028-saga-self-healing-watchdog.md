# ADR 0028: サガの自己修復ウォッチドッグ

## ステータス

Accepted。`crates/transfer-service`(`src/saga.rs`の`resume_action`/`sweep_to_suspense`、
`src/persistence.rs`の`scan_stuck_sagas`/`record_watchdog_retry`/`advance_saga_state`、
`src/commands.rs`の`send_*_retry`群、新規`src/bin/saga_watchdog.rs`)・
`infra/lib/account-pipeline-stack.ts`(`TransferSagaWatchdogFunction`・スケジュール駆動の
`events.Rule`・`StuckSagaEscalatedAlarm`・`SagaSweptToSuspenseAlarm`・銀行所有の仮受金口座)・
`infra/scripts/setup-suspense-account.ts`(新規)に実装する。`cargo test`/`cargo clippy`
(全crate、警告0件)・`infra`のCDK synth(52件)はgreen。デプロイ後、`api-e2e`
(`scenarios/saga-self-healing.e2e.test.ts`、2シナリオ)をライブスタックに対して実行し、
「詰まる→再送しても詰まったまま→条件解消→再送で回復」と「条件が解消しないまま再送上限を
超える→仮受金口座へ確定的に退避」の両方を実機で確認済み(green)。`api-e2e`フルスイート
(29ファイル/63テスト)も実行し、無関係な2件の一時的な失敗(並列実行時のワーカー競合——
`transfer-furikae`と`conservation-property`、いずれも単独再実行でgreen、本ADRの変更とは
無関係)を除いて回帰なしを確認した。

**副産物1**: 実機検証中に、`saga_step.rs`が呼ぶ`advance_saga_state`が状態不変の遷移
(`Compensating`での却下の無反応)でも無条件に`updatedAt`を更新してしまい、ウォッチドッグの
「一定時間動きがない」判定が却下観測のたびにリセットされる実バグを発見・修正した——
`next == expected_current`の場合はDynamoDBへの書き込み自体をスキップする(詳細は決定6参照)。

**副産物2**: 決定7デプロイ後の実機検証で、ウォッチドッグの再送が固定`MessageDeduplicationId`
のためSQS FIFOの重複排除窓(5分)内でサイレントに握りつぶされ、`watchdogRetryCount`は
増えるのに実際にはaccount-service/fee-serviceへ一度も配信されないという、決定3の安全性分析が
見落としていた実バグを発見・修正した(詳細は決定8参照)。

## コンテキスト

[[0010-transfer-service-saga]]決定6は「`Compensating`のまま滞留するケースへの対応は本ADRの
スコープ外(自動リトライやDLQ的な仕組みは設計しない、運用上のアラート・手動対応を前提とする)」
と明記していた。`docs/production-readiness-matrix.md`のR7・`docs/decision-tables.md`はこれを
既知のギャップとして記録するに留めていた。

このギャップを「詰まったままのシナリオを実演するテストを追加する」ことで消化しようとしたところ、
それでは`docs/insights.md`に足す新しい知見にならない(既知の事実の再確認に過ぎない)という
指摘を受けた。本ADRは、実際に**イベント駆動の枠内で自己修復を設計・実装・検証する**ことに
取り組んだ結果である。

決定1〜6(再送ウォッチドッグ)の実装後、さらに「バンキングのシステムなので『多分大丈夫』では
困る。組戻しに失敗し続ける場合は、銀行所有の口座へ一旦振り替えて確実に清算できる仕様にすべき
ではないか」という指摘を受けた。これも正しい指摘で、再送を繰り返してもCloudWatchアラームを
鳴らすだけでは、エスカレーション後もサガが`Compensating`のまま無期限に宙に浮き、システムとして
の結論が未確定のままになる。実世界の銀行・決済システムには確立された解決策がある: **仮受金
口座(サスペンス口座/GL suspense account)**——SWIFT送金が受取人に届けられなかった場合の
コルレス銀行内部清算口座、ACHの返却処理、決済ネットワークの「unmatched suspense」、会計上の
仮受金勘定など、いずれも「絶対に受け取れる、組織自身が所有する口座」へ一旦資金を逃がすことで、
システムとしての結論を必ず確定させる(資金の所在が常に追跡可能)という共通の設計思想を持つ。
「顧客への現実の返金」はそこから先の別の(システム外でもよい)手段に委ねる——このPoCが一貫して
線引きしている組織的リアリズム(運用プロセス)の外に自然に置ける。決定7がこれを実装する。

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

**この分析自体、5分を過ぎてからの重複排除だけを検討しており、実機検証で決定8が発見した
「5分以内の再送はそもそも配信されない」という逆方向の失敗モードを見落としていた**——
決定8で修正済み。

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

**実機検証で発見した関連バグの修正**: `saga_step.rs`が呼ぶ既存の`advance_saga_state`は、
`next == expected_current`(状態が実際には変わらない遷移、例: `Compensating`での却下の
無反応)でも無条件に`UpdateItem`を発行し`updatedAt`を更新していた。これにより、ウォッチドッグの
1回目の再送が引き起こす却下の観測(状態は`Compensating`のまま)のたびに`updatedAt`が
「今」に更新され、`scan_stuck_sagas`の「一定時間動きがない」という判定基準がリセットされて
しまい、2回目以降の再送が`STUCK_THRESHOLD`(10分)ぶん遅延する——実質的に5分ごとのスケジュール
では**ほぼ再送が進まない**という設計上の欠陥だった。`advance_saga_state`を「`next ==
expected_current`のときは書き込み自体を行わない」よう修正した。`updatedAt`の本来の意味
(「直近の**状態遷移**時刻」)からしても、状態が変わっていないのに更新するのは誤りであり、
この修正はウォッチドッグ以外の既存の呼び出し元にも一般的に正しい。

### 7. 再送上限を超えた`Compensating`は、銀行所有の仮受金口座へ確定的に退避する

`SagaState`に新しい終端状態`SweptToSuspense`を追加する。既存の`Compensated`(正当な持ち主に
戻った)とは意図的に区別する——「資金は安全だが正当な持ち主にはまだ届いていない」ことを表し、
突合(reconciliation)の対象を機械的に抽出できるようにする。

適用範囲は`Compensating`だけに絞る: `ReservingFee`/`PendingDebit`/`PendingCredit`は却下されても
`Failed`等の確定した終端状態へ必ず進む(却下=お金は動いていない、が確定する)——「詰まったまま
無反応」になりうるのは`Compensating`(補償の入金が却下され続け、`advance`が`NextAction::None`
のno-opとして扱う設計)だけである。他の3状態には「入金先を差し替える」という安全なフォール
バックの根拠が無い(お金がどこにあるか自体が未確定なため機械的に確定させられない)ため、
引き続き決定4のアラームのみに留める。

`saga.rs`の`sweep_to_suspense(saga, suspense_account_id, now)`(純粋関数、`resume_action`と
同じ形)が`(TransferSaga{state: SweptToSuspense, ..}, NextAction::IssueSuspenseSweepDeposit{account_id, amount})`
を返す——`resume_action`のCompensating分岐と同じ金額計算(`saga.amount + saga.cash_fee`)を、
宛先だけ差し替えるだけ。`bin/saga_watchdog.rs`は`candidate.retry_count >= MAX_WATCHDOG_RETRIES`
かつ`state == Compensating`のときにこれを呼び、状態遷移の書き込みは既存の
`persistence::advance_saga_state`をそのまま再利用する(`expected_current = Compensating`,
`next = SweptToSuspense`)——新しい永続化関数は不要。

銀行所有の仮受金口座は`infra/lib/account-pipeline-stack.ts`の固定`SUSPENSE_ACCOUNT_ID`
(クライアント生成ID方式、[[0006-write-path-api-gateway-sqs-direct-integration]]決定2)を、
`infra/scripts/setup-suspense-account.ts`(新規)がaccount-serviceのコマンドキューへ**直接
SQS送信**して開設する——[[0010]]決定1と同じ経路(API Gateway/Cognitoを経由しない、
`requested_by`が無いため`resolve_owner_id`は`owner_id`を上書きしない)。**この口座は
[[0016-cognito-authentication]]の所有者検証だけで構造的に凍結・解約不能になる**:
`owner_id = "system:suspense"`は実在のCognito subと一致し得ないため、`Freeze`/`Unfreeze`/
`Close`の`requested_by == owner_id`チェックにより、どの顧客からのリクエストも`NotOwner`で
却下される。account-domain/account-serviceへの変更は一切不要。

退避が成功したら、`StuckSagaEscalated`とは別のCloudWatchカスタムメトリクス
`SagaSweptToSuspense`(namespace `Moneta/TransferSaga`)を発行し、専用の`SagaSweptToSuspenseAlarm`
で運用者に見せる——「原因不明でまだ解決していない」(`StuckSagaEscalated`)とは異なる、
「資金は安全だが、正当な持ち主への決済は別途システム外の手段で完了させる必要がある」という
運用上の意味を持つため。

### 8. 再送専用の`MessageDeduplicationId`に`attempt`番号を埋め込む
——決定3の安全性分析が見落としていた「5分**以内**の再送は握りつぶされる」という実バグの修正

決定7のデプロイ後、シナリオ1(条件解消後の自動回復)を実機で検証したところ、口座凍結を解除した
後もサガが`Compensating`のまま進まなかった。`moneta-account-events`を`correlationId`で
直接スキャンして原因を特定: `watchdogRetryCount`は起動のたびに正しく増えていたが、
1回目の却下イベントの後、account-serviceには**それ以降のどの再送も一度も届いていなかった**。

原因は`commands.rs`の`send_command`が使う`MessageDeduplicationId`——`send_withdraw`/
`send_deposit`/`send_compensating_deposit`/`send_reserve_fee`はいずれも
`{correlation_id}-{action}`という、同じサガ・同じアクションに対して常に**同一の固定値**に
なる設計([[0010]]決定5)。これは「1つのアクションを1回だけ発行する」という`saga_step.rs`/
`command_intake.rs`の前提では正しいが、ウォッチドッグは同じサガ・同じアクションを**複数回**
発行しうる。SQS FIFOの重複排除は5分間の窓に限定される([AWS公式ドキュメント](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html))ため、5分間隔スケジュールで動く
ウォッチドッグの再送は、直前の再送から5分経っていなければ固定キーのままSQSに黙って
重複排除され、account-service/fee-serviceに一度も配信されない。

決定3の安全性分析は「5分を**過ぎて**からの再送は二重適用を防げない」というリスクだけを
検討しており、この「5分**以内**の再送はそもそも配信されず、何も達成しない」という逆方向の
失敗モードを見落としていた——実害としてはこちらの方が深刻: 二重適用ではなく、
**ウォッチドッグ機構そのものが実質的に機能しない**(`watchdogRetryCount`だけが増え続け、
実際のコマンドは初回の1通しか届かない)結果になる。

修正: `commands.rs`に`send_reserve_fee_retry`/`send_withdraw_retry`/`send_deposit_retry`/
`send_compensating_deposit_retry`(既存の`send_*`と同じ発行ロジックだが、
`{correlation_id}-{action}-retry-{attempt}`という、呼び出しごとに単調増加する
`watchdogRetryCount`を埋め込んだ一意な`MessageDeduplicationId`を使う)を追加し、
`bin/saga_watchdog.rs`の再送経路(`issue_retry_action`、新設)だけをこちらに切り替えた。
`issue_sweep_action`(決定7の仮受金退避、新設)は1回限りの終端アクションのため既存の
`send_suspense_sweep_deposit`(固定キー)のままで安全——`issue_action`という1つの関数が
両方の呼び出し元(通常の`saga_step.rs`/`command_intake.rs`用と、ウォッチドッグの再送用)を
兼ねていたのが今回の見落としの根本原因だったため、目的ごとに分離した。修正後、両シナリオを
再度実機で確認しgreen(前掲の副産物2)。

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
- **仮受金口座への退避は「解決」ではなく「確定的な保留」である**——正当な持ち主への実際の
  決済は依然として人手のフォローアップ(このPoCのスコープ外の運用プロセス)を要する。
  この決定が保証するのは「資金の所在が常にシステム上で追跡可能である」ことであり、
  「顧客が最終的にお金を受け取る」ことそのものではない——`SagaSweptToSuspenseAlarm`は
  その残作業を運用者に確実に引き継ぐためのものである。
- **仮受金口座自体が(人為的なミス等で)将来凍結・解約される可能性は理論上ゼロではない**——
  現状の保証は「顧客はこの口座を凍結・解約できない」という所有者検証止まりで、運用者自身の
  誤操作までは防げない。このPoCの規模ではこの残余リスクを許容する。

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
- **`Compensating`だけを対象にする(R7が指す状態に限定する、再送については)**: 詰まる根本原因
  (CAS成功後・コマンド発行前のLambdaクラッシュ)は`ReservingFee`/`PendingDebit`/
  `PendingCredit`にも等しく起こりうるため、1つの状態だけを特別扱いする理由がない。
  `expected_step`が`Some`を返す4状態全てに一般化する方が、1つの仕組みで済み設計として
  一貫する(**ただし決定7の仮受金退避は`Compensating`だけに限定する**——他の3状態には
  「入金先を差し替える」という安全なフォールバックの根拠が無いため)。
- **決定7: Custom ResourceでCFNデプロイ時に仮受金口座を自動開設する**: [[0013-migrate-account-service-off-aurora-dsql]]がスキーマ移行のCustom Resourceを削除した方向性と逆行する。
  固定IDの共有(クライアント生成ID方式の応用)だけでチキンエッグを解消できたため不要。
- **決定7: `Compensated`をそのまま流用し、`swept`フラグを別属性で持たせる**: 「正当な持ち主に
  戻った」と「資金は安全だが届いていない」を同じ状態値で表現すると、突合(reconciliation)の
  対象を機械的に抽出できなくなる——別の終端状態として明示的に区別する方を選んだ。

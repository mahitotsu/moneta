# E2Eテストシナリオ一覧

## 位置づけと書き方の規約

このドキュメントは`docs/adr/`(なぜその設計にしたかの決定履歴)、[production-readiness-matrix.md](production-readiness-matrix.md)
(トップダウンの3層+1分類軸で、対応するADRの決定・テストの有無を機械的に洗い出した完全性の根拠)
とは別の性質を持つ。**このドキュメントは、その2つを踏まえて実際に自動化する(または意図的に
手動確認に留める)Given/When/Thenシナリオそのものを記述する台帳**である。

シナリオIDは`production-readiness-matrix.md`の行ID(`FC#`/`R#`/`O#`/`S#`/`P#`/`E#`/`L#`)を
そのまま使う(2026-08-10、旧A〜Jのアルファベット割り当てを廃止して移行)。1行IDに対して
1つ以上のGiven/When/Thenが対応する。

- 各シナリオはGiven/When/Thenを**外部契約の言葉だけ**で書く。関数名・テーブル名・内部モジュール名は
  使わない(例外: 「何を検証したいか」を示すため、各シナリオ末尾に裏付けとなったADR/マトリクスの
  行へのリンクを付す)。
- 「外部」とは、Web UI/APIクライアントから観測可能な範囲を指す:コマンドAPI・照会APIのレスポンスと
  そのタイミング、Web UIの画面表示。
- 優先度は3段階。**P0**: 自動E2Eとして実装する。**P1**: 自動化するが優先度は低い、または手動確認と
  自動化を併用する。**P2**: 現時点では自動化が困難(障害注入・負荷生成基盤等が要る)なため、手動確認
  のみとし、将来の自動化候補として記録に残す。
- `production-readiness-matrix.md`で🔴(ADRの決定すら存在しない)と判定された行は、シナリオを書く前に
  まずADRへの根拠の追記が必要な場合がある。その場合は該当ADRへの追記提案をシナリオの前提として明記する。

## アクター

- **顧客** (`CustomerFlow.tsx`、ダミーサインイン): 口座一覧・残高・履歴閲覧、凍結/凍結解除/解約。
- **外部チャネル** (`ChannelEmulatorScreen.tsx`、サインイン不要): ATM入出金、他行からの振込、収納機関への支払い。
  中身は`Deposit`/`Withdraw`コマンドそのもの。
- **APIクライアント(生)**: UIを介さず`Idempotency-Key`等を直接制御してコマンドAPI/照会APIを呼ぶ。
  冪等性・同時実行・検証層の境界など、UIの画面操作だけでは再現しづらいシナリオに使う。
- **運用者**: CloudWatchアラーム・DLQ・ダッシュボードを見る側。現時点でこの視点のシナリオはP2が中心
  (`production-readiness-matrix.md`のO1/O2が🔴のため)。

---

## ⓪ 機能的正しさ(Functional Correctness)

`production-readiness-matrix.md`の「⓪機能的正しさ」に対応。旧`e2e-scenarios.md`のA/B/G/H/J(正常系)を
新IDへ引き継ぐ層。大半は実装・自動化済み。

**FC1: 口座開設**
Given 未使用の口座ID、有効な初期残高
When `PUT /accounts/{id}` を呼ぶ
Then `202 Accepted`が返り、最終的に`GET /accounts/{id}`が`Active`・指定した初期残高を返す。
既にOpen済みの口座IDへの再Open、負の初期残高、小数点3桁以上の初期残高はいずれも却下され、
既存の状態が保持される。存在しない口座IDに対してOpen以外の任意のコマンドを送っても`Active`化
されない(却下される)
→ [[0006-write-path-api-gateway-sqs-direct-integration]] — **P0** — `open-account.e2e.test.ts`・
`domain-errors-not-found.e2e.test.ts`

**FC2: 入金(Deposit)**
Given `Active`な口座
When 外部チャネル画面(ATM入金/他行からの振込、バックエンド挙動は同一)から入金を実行
Then `202 Accepted`が返り、最終的に残高が入金額分増加する。`Frozen`/`Closed`な口座への入金、
負またはゼロ額での入金はいずれも却下され、残高が変化しない
→ [[0009-web-ui-customer-experience-and-channel-emulation]] — **P0** — `deposit-withdraw.e2e.test.ts`・
`domain-errors-*.e2e.test.ts`

**FC3: 出金(Withdraw)**
Given 残高が出金額以上の`Active`な口座
When 外部チャネル画面(ATM出金/収納機関への支払い、バックエンド挙動は同一)から出金を実行
Then 最終的に残高が出金額分減少する。残高不足、`Frozen`/`Closed`な口座、負またはゼロ額での出金は
いずれも却下され、残高が変化しない
→ **P0** — `deposit-withdraw.e2e.test.ts`・`domain-errors-*.e2e.test.ts`
(負/ゼロ額の出金は`account.rs`の`withdraw_zero_or_negative_is_rejected`単体テストと、
`domain-errors-active-account.e2e.test.ts`のFC3新規テストで実装済み・2026-08-10。
[decision-tables.md](decision-tables.md)発見1の是正)

**FC4: 凍結/凍結解除**
Given `Active`な口座
When 顧客画面から凍結 → 凍結解除
Then 凍結中は入出金が却下され続け、解除後は通常通り入出金できる。既に`Frozen`な口座への再凍結、
既に`Active`な口座への凍結解除はいずれも却下され、状態が変化しない
→ **P0** — `domain-errors-frozen-account.e2e.test.ts`・`unfreeze-lifecycle.e2e.test.ts`

**FC5: 解約**
Given `Active`または`Frozen`な口座(凍結中でも先に凍結解除せず直接解約できる)
When 顧客画面から解約 → その後、外部チャネルから入出金を試みる
Then 解約後は残高・状態ともに変化しない。`GET /accounts/{id}`は`Closed`・`final_balance`を返す。
解約済み口座への任意のコマンドは却下される
→ **P0** — `domain-errors-closed-account.e2e.test.ts`・`domain-errors-frozen-account.e2e.test.ts`
(`Frozen`からの直接解約は2026-08-10に追加。単体テスト`frozen_account_can_be_closed_directly_
without_unfreezing_first`実行・合格確認済み。[decision-tables.md](decision-tables.md)発見2の是正)

**FC6: 取引履歴**
Given 複数回の入出金を行った口座
When `GET /accounts/{id}/transactions`を呼ぶ
Then 最終的に全件が新しい順で返り、直近50件までであること
→ **P1** — `transaction-history.e2e.test.ts`

**FC7: APIGW構造検証**
Given 任意の口座
When 型が異なる金額(`"abc"`)、必須項目欠落(`initial_balance`)、enum外の`FreezeReason`を送る
Then いずれも`4xx`でSQSに到達する前に拒否される
→ [[0006]]決定4/5 — **P0** — `input-validation.e2e.test.ts`
**未実装(P1へ格上げ推奨)**: 金額が小数点3桁以上(例: `"10.123"`)の場合の`4xx`拒否は境界値として
一度もテストされていない。`account-domain`の`InvalidAmountPrecision`は実デプロイで発見された本物の
バグ(DBラウンドトリップ由来のスケールのブレ)への対処であり、この境界が実際にAPIGWレベルで
機能し続けていることを継続的に確認する価値が高い
→ `production-readiness-matrix.md` FC7

**FC8: 既知のギャップ(不正な形式の`accountId`)**
Given 不正な形式(UUID以外)の`accountId`
When コマンドを送る
Then クライアントには`202 Accepted`が返るが、実際には反映されない(最終的にDLQへ)
→ [[0006]]「今回のスコープ外として残す既知のギャップ」— **P1** — `known-gap-malformed-account-id.e2e.test.ts`
(バグではなく明示的に受け入れたギャップであることを固定する回帰テスト)

**FC9: 顧客/外部チャネル画面のUI分離**
Given 顧客としてサインイン
When 口座詳細画面を確認する
Then Deposit/Withdrawへの導線が存在しない(UIからは外部チャネル画面を経由しないと到達できない)。
外部チャネル画面はサインイン不要で、口座IDを直接入力して操作できる。ある端末で口座を開設し
顧客に紐づけても、別のブラウザプロファイル(localStorageが空)で同じ顧客としてサインインすると
口座一覧に現れない(顧客-口座関係が端末ローカルで、バックエンドに顧客概念がないことの外部観測)
→ [[0009]]決定1・決定2 — **P1・未実装**(`ui-e2e/`はTransfer画面のみ自動化済みで、この画面群は
未着手。`api-e2e/README.md`が自己申告している既知の未実装。localStorage分離の部分は自動化の
優先度は低いが、仕様の意図的な割り切りとして記録価値がある)

**FC10: 送金(振替)の基本正しさ**
Given 送金元・送金先が同一名義
When 送金元の残高以下の金額で送金を要求する
Then `Confirm`を待たずに即座に出金コマンドが発行され、最終的に送金元の残高が減り送金先の残高が
同額増える。送金元の残高不足、同一口座への送金はいずれも要求時点で却下される
→ [[0011-furikae-furikomi-distinction]]決定1・決定3 — **P0** — `transfer-furikae.e2e.test.ts`・
UI上のハッピーパスは`ui-e2e/scenarios/transfer-furikae.spec.ts`

**FC11: 送金(振込)の基本正しさ**
Given 送金元・送金先の名義が異なる
When `Start`で送金を要求する
Then サガは`pending_confirmation`で停止し(account-serviceには何も発行されない)、`Confirm`すると
出金→着金が進む。上限額を超える金額は`Start`時点で却下される
→ [[0011]]決定3・決定4 — **P0** — `transfer-furikomi.e2e.test.ts`・UI上の確認/取消ボタンは
`ui-e2e/scenarios/transfer-furikomi.spec.ts`

**FC12: 組戻し(recall)の基本正しさ**
Given `credited`済みの振込
When 時間窓内に`Recall`を要求する
Then 逆方向の送金として実行され、最終的に送金先の残高が減り送金元の残高が同額戻る。時間窓超過・
受取人の残高不足はいずれも組戻しの失敗として観測される
→ [[0011]]決定5 — **P0** — `transfer-recall.e2e.test.ts`・UI上は`ui-e2e/scenarios/transfer-recall.spec.ts`
組戻しは振込専用という業務境界の外部観測(2026-08-10追加。API・UIとも実行・合格確認済み(2026-08-12)。
UI固有の主張(振替の完了画面には「組戻す」ボタンがそもそも描画されない、TransferDetailScreen.tsx
の`kind===furikomi`条件)は`ui-e2e/scenarios/transfer-furikae.spec.ts`に追加。
[decision-tables.md](decision-tables.md)発見5の是正) → `production-readiness-matrix.md` FC15

**FC14: サガの二重操作拒否**
Given `PendingDebit`以降(確認済み)または終端状態のサガ
When 同じ`transfer_id`に対して`Confirm`または`Cancel`を再度要求する
Then いずれも却下され、サガの状態は変化しない
→ [saga.rs:181-191](../crates/transfer-service/src/saga.rs#L181-L191)の`ConfirmError`/
`CancelError::NotPendingConfirmation` — **P2**(2026-08-10追加。E2Eはライブスタックに対して実行・合格確認済み(2026-08-12)。
[decision-tables.md](decision-tables.md)発見4の是正) — `transfer-furikomi.e2e.test.ts`

**FC13: transfer-serviceの`start`入力検証**
Given 送金元・送金先が異なる口座
When 非正の金額(`0`・負値)で`Start`を要求する
Then サガは作成されず、送金元・送金先とも残高は変化しない
→ [saga.rs:130-141](../crates/transfer-service/src/saga.rs#L130-L141)の`StartError::NonPositiveAmount`
— **P1**(2026-08-10追加。API・UIとも実行・合格確認済み、2026-08-12)
— `transfer-furikae.e2e.test.ts`・`transfer-furikae.spec.ts`
(UI固有の主張: `TransferForm.tsx`は金額をクライアント側検証しないため実際に送信できてしまうが、
Startは202を返しサガが作られないため、エラー表示ではなく「反映待ち」画面のまま留まる——
ADR-0012決定6の既存トレードオフ(結果整合性のラグと真に存在しないIDを区別しない)の延長。
小数点3桁以上の`InvalidAmountPrecision`はAPIGWの構造検証が先に4xx拒否するためE2E到達不能。
FC7と同じ理由で単体テストのみに留める)

---

## ① AWS Well-Architected Framework

### 信頼性(Reliability)

**R1: 同一集約への並行書き込みでの整合性**
Given 残高が片方の出金額しか賄えない`Active`な口座
When 同一口座に対し、合計すると残高を超える2件の出金をほぼ同時に送る
Then 最終的に片方は成功・片方は却下され、残高がマイナスにならない。10件規模の同時入金でも
全件が取りこぼしなく反映される
→ [[0002-sqs-message-lifecycle-and-error-classification]]決定1 — **P0** — `concurrency.e2e.test.ts`・
`concurrency-volume.e2e.test.ts`
**注記**: この結果はFIFOの`MessageGroupId`直列化(AWSが「1グループにつき同時に1つのLambda実行」を
保証)で説明がつき、R2のOCCリトライが発火しなくても成立する。「OCC競合からの回復」の証拠としては
使わない(R2参照)。

**R2: DynamoDB OCC競合からのLambda内リトライでの回復**
Given 同一口座に対する2つの書き込みが、同一`MessageGroupId`の直列化保証を破って本当に同時に
DynamoDBへ書き込もうとする状態
When 1つ目が先に`version`を更新する
Then 2つ目は`ConditionalCheckFailedException`を受け取り、最大3回・指数バックオフ+ジッターで
リトライし、最終的に正しい`version`で成功する
→ [handler.rs](../crates/account-service/src/handler.rs) — **P0**(2026-08-10実装。ADR-0002に
具体的トリガーを追記した上で、`aws-smithy-mocks`によりDynamoDBクライアントをHTTPトランスポート
層でモック化した単体テスト`optimistic_lock_conflict_is_retried_in_lambda_and_eventually_succeeds`
を実装、`cargo test -p account-service`で合格確認済み。`production-readiness-matrix.md` R2)

**R3: SQSレベル再配信からの回復(ブロック中)**
Given Lambda内リトライ(R2)を使い切ってなお解決しなかったメッセージ
When `maxReceiveCount`の範囲内で再配信される
Then 再配信後の処理で成功し、正しく状態が反映される(冪等性ログにより二重適用されない)
→ [[0002]]決定6 — **P2・🚧ブロック中**。現状は「失敗して最終的にDLQへ落ちる」経路(R4)しか
検証されておらず、「再配信されて回復する」成功パスは一度も観測されていない。R2と違い実AWS環境の
SQS再配信自体が要るため単体テスト化できない。**着手にはDynamoDBの持続的スロットリングを起こす
仕組み(容量を絞る、またはAWS Fault Injection Simulator)が前提条件**

**R4: 持続的インフラ障害でのDLQ到達**
Given 何らかの方法でDynamoDBへの書き込みを持続的に失敗させる
When コマンドを送り続ける
Then `maxReceiveCount`超過後にFIFO DLQに到達する
→ [[0002]]決定6 — **P1** — `group-independence.e2e.test.ts`(不正な`accountId`という持続的な
インフラ失敗を代理利用)・`known-gap-malformed-account-id.e2e.test.ts`

**R5: メッセージグループの独立性**
Given 口座A(持続的に失敗する不正な状態)と口座B(`Active`)
When 口座Aへ継続的に失敗するコマンドを送りつつ、同時に口座Bへ正常な入金を送る
Then 口座Aの失敗とは無関係に、口座Bへの入金は通常通り反映される
→ [[0002]]決定3 — **P1** — `group-independence.e2e.test.ts`

**R6: サガの補償(送金失敗時の資金保全)**
Given 送金先が入金を受け付けられない状態(凍結中・解約済み)
When 送金元の残高以下の金額で送金を要求する
Then 送金元の残高は一時的に減った後、最終的に送金前と同額まで戻る
→ [[0010-transfer-service-saga]]決定3 — **P0** — `transfer-furikae.e2e.test.ts`

**R7: サガの補償自体が却下され続けるケース**
Given 補償の入金(`Compensating`)自体が却下される状態
When 補償入金コマンドが繰り返し却下される
Then サガは`Compensating`のまま滞留し、それ以上の自動アクションは発行されない
→ [saga.rs:277-279](../crates/transfer-service/src/saga.rs#L277-L279)、[[0010]]「本ADRのスコープ外
(運用アラートでの手動対応を前提)」— **意図的に自動化対象外**。将来アラート機構(O1)を実装した際に
再検討する

**R8: 複数の発行元が同一集約を同時に取り合う安全性**
Given `Active`な口座
When 顧客/外部チャネルからの直接コマンドと、transfer-serviceが発行するコマンド(送金の一部)が
ほぼ同時に同じ口座へ届く
Then R1と同じ直列化保証のもとで、どちらも取りこぼされず、残高が破綻しない
→ **P1**(2026-08-10実装。E2Eはライブスタックに対して実行・合格確認済み、2026-08-12) — `concurrency-cross-producer.e2e.test.ts`
(`production-readiness-matrix.md` R8。`commands.rs`が直接コマンドと同じ`MessageGroupId`
(口座ID)を使う設計になっていることの検証を兼ねる)

**R9: DynamoDBスロットリング・接続断からの回復(ブロック中)**
Given 何らかの方法でDynamoDBへのアクセスを一時的に不安定にする
When コマンドを送る
Then スロットリング/接続断はインフラ起因の失敗として扱われ、最終的に正しく反映される
→ **P2・🚧ブロック中**。「回復」自体(SQS再配信をまたぐ)はR3と同じ理由でブロック中。ただし
「スロットリングが正しくInfraとして分類・伝播される」ことは、R2と同じ`aws-smithy-mocks`パターンで
`ProvisionedThroughputExceededException`を返させれば単体テストで決定論的に検証できる
(次に着手するならここが低コスト)

### 運用上の優秀性(Operational Excellence)

**O1: DLQ滞留・エージングへのCloudWatchアラーム**
Given DLQにメッセージが滞留している、または最古メッセージの経過時間が閾値を超えている
When その状態が続く
Then CloudWatchアラームが発報する
→ [[0002]]決定6 — **P0**(2026-08-10実装。両DLQ(account/transfer)に
`ApproximateNumberOfMessagesVisible`/`ApproximateAgeOfOldestMessage`アラームを追加し、CDK
synthテストで検証。`infra`の`npm test`実行・25件全合格確認済み) — `infra/lib/account-pipeline-
stack.ts`の`addDlqAlarms`

**O2: ビジネスレベルの可観測性**
Given OCCリトライ・サガの滞留等が発生している
When 運用者がCloudWatchを見る
Then リトライ発生数・サガ滞留数などのカスタムメトリクスで状況を把握できる
→ **P2**(2026-08-10、まずリトライ分岐へのログ追加のみ実装。`cargo check`/`clippy`確認済み。
カスタムメトリクス化は引き続き未着手) — [handler.rs](../crates/account-service/src/handler.rs)

**O3: デプロイの安全性**
Given CDKスタックの変更
When `cdk synth`を実行する
Then Lambdaのバンドル・IAMポリシー等が期待通り生成される
→ **P0(既存)** — `infra/test/`、CI(`ci.yml`)

**O4: IAM境界の回帰防止**
Given query projectorのIAMポリシー
When CDK synthを実行する
Then account-service自身のテーブル(accounts/account_events/processedMessages)へのアクセス権が
付与されていないことを確認する
→ [[0013-migrate-account-service-off-aurora-dsql]]決定5 — **P0(既存)** —
`infra/test/account-pipeline-stack.test.ts:206`

**O5: 実運用トラブル発生時の切り分け手順(runbook)**
⚪ **対象外**。CLAUDE.mdが明記する通り、運用プロセス(組織的リアリズム)はこのPoCの意図的な
スコープ外

### セキュリティ(Security)

**S1: 認証・認可・セッション管理**
🟡 **意図的にスコープ外**。[[0007-web-ui-stack-and-hosting]]/[[0009]]が「認証UIなし・ダミー
サインイン」と明記。シナリオなし

**S2: IAM最小権限**
→ O4と同一(重複整理)

**S3: 入力の構造的検証**
→ FC7と同一(重複整理)

**S4: 敵対的input耐性(ブロック中)**
Given 任意の口座
When 異常に大きい金額、極端に長い文字列、短時間の大量リクエストを送る
Then システムが不正な状態(クラッシュ・データ破損・無応答)に陥らない
→ **P2・🚧ブロック中**。ADR・テストともに一度も言及なし(`production-readiness-matrix.md` S4)。
**テスト以前に「どこまでをサポートする振る舞いとして定義するか」のADRが先に必要**——この判断が
ないと何を「正しい」とみなすかの基準がない

**S5: 保存データの暗号化**
⚪ **対象外**。DynamoDB既定のAWS管理暗号化に依存し、アプリケーション側の設計判断が存在しない

**S6: シークレット管理**
⚪ **対象外**。IAMロールベースの認可のみで、APIキー等のシークレット自体が設計上存在しない

### パフォーマンス効率(Performance Efficiency)

**P1: 結果整合性の遅延境界(単発操作)**
Given `Active`な口座
When 入金コマンド送信の直後(数秒以内)に`GET /accounts/{id}`を呼ぶ、または
`GET /accounts/{id}/transactions`を呼ぶ
Then 旧残高・旧履歴が返ることがある(失敗ではない)。ポーリングを続けるとまもなく新残高・新しい
取引履歴エントリに収束する(両者は同じアウトボックス機構に基づくため同様の遅延窓を持つ)
→ [[0004-query-service-event-driven-projection]]「結果整合性のトレードオフ」— **P0** —
`eventual-consistency.e2e.test.ts`・`transaction-history-lag.e2e.test.ts`

**P2: 実運用に近い流量での挙動(ブロック中)**
Given 数十〜数百の異なる口座
When それぞれに対して同時多発的に入出金・送金が発生する
Then Lambdaの同時実行数(メッセージグループIDの異なる数に応じてスケールする、AWS公式ドキュメント
参照)が適切にスケールし、個々の口座単位の正しさ(R1)が流量が増えても崩れない
→ **P2・🚧ブロック中**。全ての並行性テストが「1口座に対し2〜10件」規模に閉じている
(`production-readiness-matrix.md` P2)。**着手には負荷生成ツール(k6・Artillery等)の新規導入が
前提条件**——`api-e2e`の既存のJestベースの仕組みでは非現実的な規模。I1と同じ「手動/オンデマンド、
実環境限定」という位置づけになる見込み

**P3: 流量に応じた結果整合性の遅延劣化(ブロック中)**
Given P2と同じ高流量状態
When 結果整合性の収束時間を計測する
Then 無負荷時(P1)からの劣化が許容範囲に収まる、または劣化の実測値が記録される
→ **P2・🚧ブロック中**。P2と同じ負荷生成基盤に依存

### コスト最適化・持続可能性

⚪ **対象外**。この記事の主張(イベント駆動アーキテクチャの技術的妥当性)と無関係

---

## ② イベント駆動アーキテクチャ固有のリスク

**E1: at-least-once配信での重複排除(冪等性)**
Given `Active`な口座
When 同じ`Idempotency-Key`で同じ入金コマンドを2回送る
Then 残高は1回分しか増加しない。ヘッダー欠落は`4xx`でSQSに到達しない。異なるキーで同内容の
コマンドを送った場合は意図通り2回分反映される
→ [[0002]]決定4・[[0006]]決定3 — **P0** — `idempotency.e2e.test.ts`・`idempotency-distinct-keys.e2e.test.ts`

**E2: メッセージ順序保証(ブロック中)**
Given 同一口座への複数コマンドを送信順が保証されない形で並行送信する
When サーバ側が受信する
Then `SequenceNumber`による明示ソートにより、送信順通りに適用される(到着順ではなく送信順)
→ [[0002]]決定5 — **P1・🚧ブロック中**。R1/R2は「壊れないこと」は見るが、「送信順と異なる到着順
でも正しくソートされる」ことを狙って作られたテストではない。**SQSは到着順を外部から制御する手段を
公式に提供しないため、E2Eで意図的に順序を乱すのは困難**。`grouping.rs`のソート処理自体は既に
単体テスト済み(`messages_arriving_out_of_order_are_sorted_by_sequence_number_within_group`)
(`production-readiness-matrix.md` E2)

**E3: 毒メッセージ/DLQ**
→ FC8/R4と同一(重複整理)

**E4: バックプレッシャー・スケーリング特性**
→ P2と同一(重複整理)

**E5: イベントスキーマの後方/前方互換性**
🟢 **型システムによる保証(実行時テストではない)**。`account_domain::Event`をproducer/consumerで
共有するモノレポ構成のため、新バリアント追加は全一致箇所でコンパイルエラーになる(CLAUDE.mdの
「ワイルドカード禁止」規約)。シナリオなし。本物の複数言語・複数リポジトリ環境でのスキーマ進化は
このPoCの構成上そもそも発生しない

**E6: サガの補償失敗モード全般**
→ R6/R7と同一(重複整理)

**E7: 結果整合性の窓(顧客体験としての扱い)**
Given 顧客画面
When 直近のコマンドがまだ照会に反映されていない状態でその口座を表示する
Then 画面は「エラー」ではなく「反映待ち」相当の表示になり、キャッシュ済みの値を優先して見せる
→ [[0001-service-boundaries-and-event-driven-integration]]のUXへの説明責任 — **P0** —
`AccountView.test.tsx`(web-ui側のVitestコンポーネントテスト)

---

## ③ 銀行元帳(ledger)固有のリスク

**L1: 資金保存則**
Given 同一名義4口座からなる閉じた系(初期合計1000)
When ランダムな組み合わせの振替(furikae)を同時多発的に発生させ続ける
Then どの時点で全体を集計しても、系全体の残高合計が常に一致し続ける(お金が増えたり消えたりしない)
→ **P1**(2026-08-10、`fast-check`を導入しプロパティベーステストとして実装。ライブスタックに対して実行・合格確認済み(2026-08-12、
fast-check numRuns=5全通過) — `conservation-property.e2e.test.ts`
(`production-readiness-matrix.md` L1。スコープは同一名義口座間の振替に絞っており、外部からの
入出金を含めた全種別の操作を混ぜた検証は今後の拡張余地として残る)

**L2: 監査ログ(アウトボックス)の完全性**
🟢 **テスト不要、構造的に保証済みと判明**。[persistence.rs](../crates/account-service/src/
persistence.rs)の`apply_command`は、状態変化(`Ok(event)`)・却下(`Err(domain_error)`)いずれの
結果でも`event_put`を無条件で`items`に積み、`processed_message_put`・`account_write`(または
`account_condition_check`)と1回の`TransactWriteItems`で原子的にコミットする。状態変化とイベント
記録が分離した書き込みになることが構造的にありえない設計であり、個別のテストで検証するまでもない
(2026-08-10確認)

**L3: 監査ログの改ざん不可能性**
Given `account_events`テーブル
When IAMポリシーを確認する
Then Update/Delete権限が存在せず、追記(PutItem)のみ可能である
→ **P0**(2026-08-10実装・実行確認済み)。**実装時に本物の過剰権限を発見**:
`accountEventsTable.grantWriteData(fn)`はコードコメントが「PutItemのみ」と謳っていたのに、
実際にはUpdateItem/DeleteItem/BatchWriteItemも付与していた(`processed_messages`側も同様)。
`dynamodb:PutItem`のみの明示的な`grant`に置き換え、CDK synthテストで検証。`infra`の`npm test`
実行・25件全合格確認済み

**L4: 非否認性**
⚪ **現時点で評価不能**。S1(認証)が前提として成立していないため、この項目自体が意味を持たない。
S1解消後に再評価

**L5: 限度額・不正検知**
Given 送金元・送金先の名義が異なる
When 上限額を超える金額で送金を要求する
Then サガは作成されず、送金元・送金先とも残高は変化しない
→ [[0011]]決定4 — **P0** — `transfer-furikomi.e2e.test.ts`(限度額のみ。不正検知エンジン自体は
`FreezeReason::SuspectedFraud`というデータ表現に留まり、実装対象外)

**L6: 突合(reconciliation、未実装)**
Given 稼働中のシステム
When 書き込み系(account-serviceの`accounts`)と読み取り系(Query serviceの投影)を全口座横断で
比較する
Then 十分な時間経過後、両者が完全に一致する
→ **P2・未実装**。P1(旧F1)は個々の口座単位の収束のみを見ており、全口座を横断した突合の仕組みは
ない

---

## 次のステップ

2026-08-10のセッションで、FC3・FC5・FC13・FC14・FC15・R2・R8・O1・O2(部分)・L1(部分)・
L2・L3に着手し、実行または型チェックまで確認済み(詳細は各シナリオの本文と
`production-readiness-matrix.md`の「集計と優先度」を参照)。`cargo test --workspace`(59件)・
`cargo clippy --workspace --all-targets`(警告0件)・`infra`の`npm test`(CDK synth、25件)は
全て合格。api-e2eのE2Eテスト自体はライブスタックがなくこの環境では実行できないため、次回
デプロイ後に`api-e2e`の`npm test`で実行確認が必要。

残っているのは以下の2種類。

1. **🚧ブロック中(この技術検証の範囲内では完了できない)**: R3・R9・P2・P3・S4・E2の6件。
   障害注入基盤・負荷生成ツール・追加のADR決定のいずれかが前提条件になっており、該当する
   行に具体的な着手条件を明記した。
2. **未着手だが技術的には着手可能**: L6(突合)、④のD5-D10・D16・D17の判断の一部。

⓪機能的正しさ層は[decision-tables.md](decision-tables.md)の状態遷移表・ディシジョンテーブルで
再検証済み(2026-08-10)。`AccountState`/`SagaState`に新しい状態や遷移を追加した際は、この決定表を
先に更新してから本ドキュメントに反映する運用にする。

本ドキュメントとテストコード(`api-e2e`/`ui-e2e`/各crateの単体テスト)の対応は新IDに揃え済み
(2026-08-10)。

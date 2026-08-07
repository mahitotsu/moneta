# ADR 0011: 振替(furikae)/振込(furikomi)の区別 — 名義データ・確認・組戻し

## ステータス

Accepted。`crates/account-domain`の`Command::Open`/`Event::Opened`/`Account`への`owner_id`
追加、`crates/account-service`の`schema.sql`/`persistence.rs`への同列の伝播、
`crates/transfer-service`の`saga.rs`/`persistence.rs`/`bin/command_intake.rs`/新規
`bin/owner_projector.rs`、`infra/lib/account-pipeline-stack.ts`のOpenCommandModel/VTLと
Transfer serviceセクション(`TransferAccountOwnersTable`/`TransferOwnerProjectorFunction`/
`TransferOwnerObservationRule`)、`web-ui`のOpen導線に直接反映する。顧客向けAPI Gateway/Web UI
(振替/振込フォーム、名義確認画面、recallボタン)は[[0010-transfer-service-saga]]決定6が
据え置いた項目と合わせ、引き続きスコープ外(次の増分)。

## コンテキスト

[[0010-transfer-service-saga]]が実装したTransfer serviceは、送金元・送金先の名義が同じか
異なるかを一切区別せず、どの2口座間でも同一の無条件サガで送金していた。この点についての
議論で、実務上の振替/振込の区別が「同一銀行かどうか」ではなく「送金元・送金先の名義(顧客)が
同一かどうか」であることを確認した——同一銀行内であっても、相手が別人であれば実務上は
「振込」として扱われる。

ところがこのバックエンドには「顧客/名義」という概念が一切存在しなかった
(`account-domain`にも`schema.sql`にも無し)。この状況は[[0009-web-ui-customer-experience-and-channel-emulation]]決定2が既に予告していた——`customerSession.ts`のコメントは
「バックエンドに『顧客』という概念は一切追加しない…将来Transfer serviceを実装する際、本物の
顧客-口座関係が必要になれば見直す」と明記しており、Transfer serviceは実装済みだがこの見直し
自体は行われていなかった。今回、この見直しに着手する。

## 決定

### 1. 名義(`owner_id`)をAccountの実データとしてaccount-domainに追加する

`Command::Open`/`Event::Opened`に`owner_id: String`を追加し、`Account`構造体には
`AccountId`と同じ扱いで持たせる(`AccountState`の各バリアントには入れない)。理由:
`owner_id`は口座の状態遷移(凍結/解約)と無関係に開設時から不変な識別情報であり、balanceの
ような状態依存データと性質が異なる。`evolve`は`Event::Opened`のときだけ`owner_id`を
イベントから取り込み、それ以外のイベントでは既存の値をそのまま引き継ぐ——ここも
`Account::apply`/`evolve`の「ワイルドカードを使わない」という規約([[0003-domain-service-crate-boundary]])に倣い、全`Event`バリアントを明示的に列挙する。

クライアント申告(Transfer serviceへのリクエストに「これは振替です」という値を含めて送る
方式)ではなくサーバ側の実データとした理由: 振替/振込の判定結果によって以後の業務ルール
(確認要否・組戻し可否・限度額)が変わるため、クライアントが誤って(または意図的に)申告した
場合に業務ルールを回避できてしまう設計は金融ドメインのPoCとして避けるべきと判断した。

`schema.sql`の`accounts`テーブルに`owner_id TEXT`列を追加(NULL許容)。DSQLでは既存デプロイに
後からNOT NULL制約を追加できない(既存行が値を持たない)ため、必須性の強制はアプリケーション
層(`Command::Open`が常に必須で要求する)に委ねる。

### 2. 振替/振込の判定は、Transfer service専用の口座名義インデックス投影で行う

Transfer serviceが送金元・送金先の名義を突き合わせるための専用の小さなイベント駆動投影
(`owner_projector.rs`、[[0004-query-service-event-driven-projection]]のパターンを踏襲)を
新設した。`account.event.Opened`だけを購読し、`{accountId, ownerId}`をDynamoDBへ書く——
名義は不変なので一度書けば十分で、ConditionExpressionも不要。

query-serviceの`AccountViewTable`に相乗りする案は採らなかった。あちらは`view_from_event`が
イベント単体からフルの新state JSONを都度PutItemする「洗い替え」設計であり
([[0004-query-service-event-driven-projection]])、`owner_id`のような`Opened`一度きりで
決まる不変データをDeposited/Withdrawn等の書き込み時に消さずに引き継ぐには読み取り-書き込み
マージが必要になり複雑化する。専用テーブルにする方が単純で、`query-service`のCargo.tomlに
何の変更も要らない([[0008-query-service-crate-extraction]]の境界を保つ)。

`command_intake.rs`は送金開始要求を受けると、送金元・送金先双方の名義をこのインデックスから
引き、一致すれば`Furikae`(振替)、不一致なら`Furikomi`(振込)と判定してから
`saga::start`を呼ぶ。**どちらかの名義がまだ見つからない場合は却下ではなく
`ProcessError::Infra`としてSQSに再配信させる**——口座作成イベントがこの投影にまだ反映されて
いないだけの結果整合性の遅延である可能性があり、これを恒久的な失敗と即断しないという
このプロジェクトの既存方針([F3](../e2e-scenarios.md)、eventual-consistency-not-a-failureの
考え方)に倣う。存在しない口座IDを指定した場合も同様に扱われ、最終的にはDLQへ積まれて運用側の
検知に委ねる——両者(遅延 vs 真に存在しない)を区別する手段(account-serviceへの直接照会)は
本ADRのスコープ外とした。

### 3. 確認必須は振込(`Furikomi`)のみ。`PendingConfirmation`/`Cancelled`という新状態で表現する

`TransferSaga`に`kind: TransferKind`(`Furikae`/`Furikomi`/`Recall`)を追加し、`SagaState`に
`PendingConfirmation`・`Cancelled`を追加した。

- `Furikae`(振替): 現行どおり確認不要で即座に`PendingDebit`へ進み、出金コマンドを発行する。
- `Furikomi`(振込): `PendingConfirmation`で止まり、何も発行しない。新規`confirm`
  (`PendingConfirmation`→`PendingDebit`+出金発行)または`cancel`
  (`PendingConfirmation`→`Cancelled`)が呼ばれるまで、account-serviceには一切コマンドが
  送られない。

`expected_step`は`PendingConfirmation`/`Cancelled`に対して`None`を返す——これらの状態では
そもそもaccount-serviceに何も発行していないため、観測すべきイベントが存在しない。
`transfer-saga-step`(EventBridge駆動)の観測ロジックはこの2状態を対象にしない。

振込にのみ確認を要求するのは、実際のネットバンキングで「振込先名義の表示・確認」が振込
固有の手続きであり、振替(自分の口座間)には無いことに対応する。

### 4. Furikomiに1件あたりの上限額を設ける

`saga::start`で`Furikomi`のときだけ上限額(`FURIKOMI_MAX_AMOUNT`相当、1,000,000)を超える
金額を`StartError::ExceedsFurikomiLimit`として却下する。`Furikae`/`Recall`には適用しない。

実際の銀行の限度額ポリシー(顧客ごとの可変設定、認証方式による段階制等)を再現するものでは
なく、「振込には振替より厳しい制約がある」ことを技術的に検証可能な形で示すための固定値である
——この単純化は意図的なPoCスコープの割り切りであり、実際の運用ポリシー設計は記事の考察点として
残す([[0001-service-boundaries-and-event-driven-integration]]と同じ「技術的妥当性優先、
組織的リアリズムは考察点」の方針)。

### 5. 組戻し(recall)は新しい終端状態を作らず、`kind = Recall`の新しいサガとして`start`を再利用する

組戻しの適格性判定は純粋関数`recall_eligibility(original, now)`で行う。条件は
`original.kind == Furikomi`(振替・組戻し自体は対象外)、`original.state == Credited`
(未着金・失敗・補償・取消済みは対象外)、`now - original.updated_at <= RECALL_WINDOW`
(24時間)の3つ。`TransferSaga`に`updated_at`(直近の状態遷移時刻)を追加し、`Credited`到達
時刻の代用として使う——terminal到達後は変化しないため十分である。

適格性を満たした場合、`command_intake.rs`は`saga::start`を`kind = Recall`・
`from = original.to_account_id`・`to = original.from_account_id`・新しい`transfer_id`で
呼び出し、独立したサガとして組戻しを実行する。受取人側の出金が
`DomainError::InsufficientFunds`等で却下される場合(既に資金が使われた、口座が凍結/解約
された等)は、既存の`PendingDebit`+却下→`Failed`の経路がそのまま「組戻し失敗」を表現する。
新しい終端状態は一切追加していない——`SagaState`の全遷移ロジック(`advance`)は無改修である。

組戻しの時間窓は、実際の銀行の組戻し可否(受取人の同意取得、資金の利用有無の照会等の運用
プロセス)を再現するものではなく、時間窓という技術的に検証可能な代理指標だけを実装した
——決定4の限度額と同じ理由でのPoCスコープの割り切りである。

## トレードオフ

- **名義投影のラグ**: `owner_projector.rs`の投影も他のアウトボックス経由の投影と同じ
  最大約1分の遅延を持つ。決定2の通りこれを却下ではなく再試行として扱うが、口座開設直後に
  即座に送金を開始しようとすると一時的に処理が止まって見える(最終的には収束する)。
- **組戻しの時間窓は固定定数で、銀行ポリシーとしての可変性がない**: 顧客ごと・取引種別ごとに
  異なる実際の運用ポリシーは実装せず、単一の定数とした。
- **`owner_id`は引き続き認証されない自己申告のダミー識別子である**: Web UIの
  `customerSession.ts`はダミーサインインのままであり([[0007-web-ui-stack-and-hosting]]/
  [[0009-web-ui-customer-experience-and-channel-emulation]]の「認証UIなし」を撤回しない)、
  `owner_id`はそのダミー顧客名をそのまま転記したものに過ぎない。「本物の名義」を検証する
  機構(本人確認・認証)はこのPoCのスコープ外のまま。
- **「名義が未検出」と「口座が存在しない」を区別しない**: 決定2の通り、どちらも
  `ProcessError::Infra`として再試行され、最終的にはDLQに積まれる。区別にはaccount-serviceへの
  直接照会が要るが、[[0010-transfer-service-saga]]決定1の「account-serviceは公開
  インターフェース経由でしか触らない」という設計の枠内では今回追加しなかった。
- **顧客向けAPI Gateway/Web UIは今回もスコープ外**: 振替/振込フォーム・名義確認画面・
  recallボタンは、[[0010-transfer-service-saga]]決定6が据え置いた項目とあわせて次の増分に
  持ち越す。ただし受付経路自体(`TransferCommand`の`Start`/`Confirm`/`Cancel`/`Recall`を
  Transfer受付キューへ直接`SendMessage`する経路)は`e2e/scenarios/transfer-*.e2e.test.ts`
  で自動E2E化済み——手動確認だけに頼る状態ではない([e2eシナリオJ](../e2e-scenarios.md)
  参照)。

## 却下した代替案

- **クライアント申告のkind**: 送金元・送金先の名義が同じかどうかをクライアントに申告させ、
  それをそのまま信じる案。誤った申告や意図的な回避で確認・限度額・組戻し制限といった業務
  ルールを迂回できてしまうため不採用(決定1)。
- **query-serviceの`AccountViewTable`にowner_idを混ぜる**: あちらの「洗い替え」方式の
  投影と相性が悪く、読み取り-書き込みマージが必要になり複雑化するため、専用の投影テーブルを
  新設した(決定2)。
- **組戻し用の新しい終端状態を`SagaState`に追加する**: `start()`を`kind = Recall`で再利用する
  方がシンプルで、既存の状態遷移ロジック(`advance`)を一切変更せずに済むため、こちらを
  採用した(決定5)。
- **サガ状態専用の新しいDSQLテーブルで名義インデックスを持つ**: [[0010-transfer-service-saga]]
  決定2と同じ理由(単一アイテムの読み書きにリレーショナル・トランザクション機構は不要、
  DSQL用のスキーマ自動適用の仕組みをもう一セット持つ重さに見合わない)で見送り、DynamoDBの
  専用テーブルとした。

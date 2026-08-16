# ADR 0023: 入出金履歴に発生源チャネルを明記する

## ステータス

Accepted。`crates/account-domain`の`envelope.rs`、`crates/account-service`の
`persistence.rs`・`outbox.rs`・`bin/account_outbox_projector.rs`、`crates/query-service`の
`history.rs`・`bin/query_projector.rs`、`infra/lib/account-pipeline-stack.ts`、`web-ui`の
`api/types.ts`・`api/client.ts`・`ChannelOperationForm.tsx`・`ChannelEmulatorScreen.tsx`・
`TransactionHistory.tsx`・`index.css`に実装する。

## コンテキスト

ユーザーから、入出金履歴の各行について「発生源(何がこの入出金を起こしたか)を明記すべき
ではないか」という指摘を受けた。[[0021-account-transfer-cross-links]]により送金由来の行
(`transferId`が付く)は送金の詳細へのリンクから推測できるようになっていたが、それ以外の
行は種別(「入金」「出金」)だけで、何が原因かが一切わからなかった。

調査すると、これは表示の問題ではなくデータ自体の欠落だった。`ChannelEmulatorScreen.tsx`
(外部チャネル・エミュレータ、[[0009-web-ui-customer-experience-and-channel-emulation]]決定1)
にはATM入金・ATM出金・他行からの振込・収納機関への支払いという4つの異なる操作があるが、
すべて同じ`deposit`/`withdraw` API呼び出しに落ちる。`ChannelOperationForm.tsx`の銀行名・
支払先名の入力欄は「表示上の飾りであり、バックエンドへは送らない」(0009決定1)と最初から
明記されており、実際どのチャネルのボタンを押したかという情報すら、リクエストが飛ぶ前に
捨てられていた。取引履歴でATM入金と他行振込入金・口座振替出金を区別する手段が、そもそも
存在しなかった。

ネットバンキングの通帳・入出金明細は本来、摘要欄で入出金の発生源(ATM/振込/口座振替等)を
示すのが当たり前であり、これが欠けると身に覚えのない入出金の早期発見(不正利用検知)という
金融アプリの中核的な価値が損なわれる。一方で、この欠落は`account-domain`の書き込みパスの
ドメインモデル自体を変更しないと直せない類のものではない——[[0010-transfer-service-saga]]
決定4の`correlation_id`が確立した「`EventEnvelope`に輸送専用のメタデータを載せ、
`account-domain`の状態遷移ロジックは一切参照しない」というパターンをそのまま延長すれば、
`Command`/`Event`に一切手を入れずに実現できる。

## 決定

### 1. `channel`を`correlation_id`と同じ「輸送専用メタデータ」として`EventEnvelope`に追加する

`account_domain::EventEnvelope`に`channel: Option<String>`を追加する。`correlation_id`と
同じ理由で型はあえて`Option<String>`のまま(専用のRust enumにしない)——`account-domain`は
この値の中身を一切知らず、`Command`/`Event`のどちらにも含めない。値の妥当性(3つの既知の
チャネル名のどれかであること)は、後述の通りAPI Gatewayのリクエストモデル(enum制約)側で
構造的に保証する方針とし、`account-domain`に型で強制させない。

### 2. 配管は`correlation_id`と全く同じ経路をもう1本通す

`AccountCommandEnvelope`(`persistence.rs`、SQSメッセージ本文)に`channel: Option<String>`
を追加し、`event_put`が`account_events`テーブルへ`channel`属性として書き込む。DynamoDB
Streams経由の`bin/account_outbox_projector.rs`がNEW_IMAGEから読み戻し、`UnpublishedEvent`
→`outbox::to_outbox_entry`を経て`EventEnvelope.channel`としてEventBridgeへ発行される。
`query-service`の`bin/query_projector.rs`が`envelope.channel`を`history::
history_entry_from_event`へ渡し、出力JSONに`channel`としてそのまま素通しする——
`correlation_id`→`transferId`と全く同じ形。`transferId`と`channel`は互いに排他
(transfer-service経由の入出金には`correlation_id`が、外部チャネル・エミュレータ経由の
入出金には`channel`が付き、両方同時に値を持つことはない)。

### 3. API Gatewayでチャネルの値を構造的に保証する

`deposits`/`withdrawals`は同じREST操作を複数の外部チャネルが共有する(例:
`POST /accounts/{id}/deposits`はATM入金と他行からの振込の両方から呼ばれる)ため、URLパスや
リソースの違いでは区別できず、リクエストボディの`channel`フィールドで明示させる。
入金・出金それぞれで実際にあり得るチャネルだけをenumで許可する2つの新しいモデル
(`DepositCommandModel`: `Atm`/`IncomingTransfer`、`WithdrawalCommandModel`:
`Atm`/`BillPayment`)を、共有していた`AmountCommandModel`から分離して定義する——
`FreezeCommandModel`の`reason`と同じ、値の妥当性をモデルの`enum`で保証する方針を踏襲する。
VTLは`requested_by`(Open/Freeze/Unfreeze/Close、[[0016-cognito-authentication]]決定3)と
同じ挿入パターンで、`$input.path('$.channel')`をMessageBodyへ注入する
(`CHANNEL_FROM_BODY_FIELD`)。`requested_by`と`channel`はどちらも
`AccountCommandEnvelope`のトップレベルの追加フィールドを注入する同じ仕組み
(`sqsIntegration`の`extraEnvelopeFieldsFragment`引数)を共有するが、使われるエンドポイントは
互いに排他的なので単一の引数で足りる。

### 4. Web UI: チャネルは実データとして送り、取引履歴に表示する

`ChannelOperationForm`に`channel: Channel`という必須propを追加し、`ChannelEmulatorScreen.tsx`
の4フォームがそれぞれ固有の値(ATM入金/出金→`"Atm"`、他行からの振込→`"IncomingTransfer"`、
収納機関への支払い→`"BillPayment"`)を渡す。銀行名・支払先名の自由記述欄(`counterpartyLabel`)
は引き続き表示専用のまま送らない([[0009]]決定1は覆さない)——今回送るのはあらかじめ
決まった小さなenumの`channel`だけで、任意の自由記述を実データ化するものではない。
`TransactionHistory.tsx`は`entry.channel`が非nullの行に`CHANNEL_LABEL`の日本語ラベル
(「ATM」「他行からの振込」「口座振替(収納機関への支払い)」)を`.tx-channel`として表示する
——`.tx-reason`(凍結理由)と同じ見た目・同じ「種別に添える1行の補足」という位置づけ。

## トレードオフ

- **`channel`はエンドツーエンドで型に強制されない**: `account-domain`〜`query-service`まで
  素の`Option<String>`のまま運ばれ、値の妥当性はAPI Gatewayの境界でしか保証されない。
  `correlation_id`が既に採用している設計と同じ割り切りであり、この仕組み自体をこのADRで
  新設するわけではない。将来API Gatewayを経由しない別の呼び出し元(transfer-serviceのような
  直接SQS送信者)が誤った値を送った場合、フロントエンドの`CHANNEL_LABEL`ルックアップは
  `undefined`を返す——`FREEZE_REASON_VIEW_LABEL[entry.reason]`など既存の同種のルックアップと
  同じリスクの水準であり、防御的なフォールバック文言は追加していない。
- **`DepositCommandModel`/`WithdrawalCommandModel`のenumはチャネルの取り違えを防がない**:
  「ATM出金」ボタンが`channel: "IncomingTransfer"`を送るような実装ミスがあっても、
  モデルのenum自体は(入金用・出金用で許可集合を分けているため)拒否できるケースとできない
  ケースが両方ある(例:出金側のenumに`"Atm"`はあるが、`"IncomingTransfer"`は無いので、
  ATM出金の実装ミスでこの値が入ることは無い設計になっている)。取り違えの実害は表示ラベルの
  誤りに留まり(残高・入出金の事実自体は変わらない)、この程度のリスクは許容する。

## 却下した代替案

- **`channel`を`FreezeReason`と同じ`account-domain`内の型付きenumにする**: `reason`は
  `Event::Frozen`の一部としてドメイン状態に組み込まれる値だが、`channel`は
  `correlation_id`と同じ「誰が/どこから呼んだか」という輸送専用の関心事であり、
  `Command`/`Event`のどのバリアントにも属さない。型を作ってdomain crateに置くと、
  「`account-domain`はAWS/DB依存だけでなく、輸送層の関心事も持たない」という
  [[0003-domain-service-crate-boundary]]/`EventEnvelope`の既存の切り分けに反する。
- **銀行名・支払先名の自由記述欄もバックエンドへ送る**: [[0009]]決定1が「表示上の飾り」と
  明示的に決めた対象であり、今回のニーズ(発生源の**種別**を示す)には無関係。任意の自由記述を
  実データとして受け入れると検証・表示の両面で扱いが煩雑になるため、あらかじめ分かっている
  小さなenumの`channel`だけを追加するに留めた。
- **`deposits`/`withdrawals`を分割し、チャネルごとに別のAPIリソースにする**
  (例: `POST /accounts/{id}/deposits/atm`): `Command::Deposit`/`Withdraw`自体は元々
  「誰が・どのチャネルから」を問わない汎用プリミティブであり([[0009]]決定1)、リソースを
  割ると`account-service`側で吸収する意味のない分岐が増えるだけになる。ボディの1フィールドで
  表現するほうが、既存の`AccountCommandEnvelope`の構造(コマンド本体+輸送メタデータ)と一致する。

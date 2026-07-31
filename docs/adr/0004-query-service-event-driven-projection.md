# ADR 0004: Query serviceとイベント駆動連携の実証(アウトボックス+EventBridge+DynamoDB読み取りモデル)

## ステータス

Accepted。account-service側のアウトボックス(`persistence.rs`の`fetch_unpublished_events`/
`mark_published`、`outbox.rs`、`src/bin/outbox_relay.rs`)とQuery Service側(`projection.rs`、
`src/bin/query_projector.rs`)の実装、および`infra/lib/account-pipeline-stack.ts`の
EventBridge/DynamoDB/API Gateway定義に直接反映する。

## コンテキスト

milestone 1(SQS FIFO + Lambda + Aurora DSQL)は実AWSで検証済みだが、
[[0001-service-boundaries-and-event-driven-integration]]が提案した「イベント駆動でのサービス間
連携」は一度も実装・検証されていなかった。書き込み経路へのAPI Gateway追加(ADR-0002の設計図)は
枯れたAWSパターンで技術的リスクが低く後回しにしても損失が小さい一方、イベント駆動連携はこのPoC
全体の核心的な主張であるため、こちらを先に検証する優先順位に切り替えた。

照会についても「マイクロサービス前提でDSQL直接照会は不可、すべてAPI経由」という方針のもと、
Query serviceを実装し、それを本来の照会経路とする(milestone 1の検証時に使っていたpsql直接照会は
この方針と矛盾するため終了する)。

## 決定

### 1. DSQLのCDC(Kinesis配信)は不採用、ポーリングベースのアウトボックスを採る

Aurora DSQLは2026年7月にCDC(Change Data Capture)がGAしたが、配信先は現状Kinesis Data Streams
のみである([CreateStream APIリファレンス](https://docs.aws.amazon.com/aurora-dsql/latest/APIReference/API_CreateStream.html)の
`TargetDefinition`)。Kinesisは稼働の有無に関わらず$0.040/stream-hourの固定費が発生し
([Kinesis料金ページ](https://aws.amazon.com/kinesis/data-streams/pricing/))、
「稼働していないときは課金されない」という本PoCのコスト方針と非互換と判断した。

代わりに、`account_events`に`published_at`列を追加し、EventBridge Scheduler(1分間隔、
Schedulerの下限)で起動する`account-outbox-relay`Lambdaが未発行行(`published_at IS NULL`)を
ポーリングして`PutEvents`する、業務レベルのトランザクショナルアウトボックスを採る。
Lambda・Scheduler・EventBridge・DynamoDB(on-demand)はいずれもアイドル時の固定費がない。

なお別途調べたところAurora DSQL自体はアイドル時DPU課金ゼロ・時間最低料金なしだった
([Aurora DSQL料金ページ](https://aws.amazon.com/rds/aurora/dsql/pricing/))。コストの観点では
Query serviceの読み取りストアを別のDSQLクラスタにする案も排除されないが、決定4の理由により
今回はDynamoDBを採用した。

### 2. 発行は「PutEvents成功 → published_at更新」の順序を守る

逆順(先にpublished_atを更新してからPutEvents)だと、その後のPutEventsが失敗した際にイベントが
永久に失われる。[[0002-sqs-message-lifecycle-and-error-classification]]が確立した「サイレントな
データロスを許さない」という設計思想をここでも踏襲する。この順序により、`account-outbox-relay`が
どのタイミングで落ちても最悪の帰結は重複発行(at-least-once)であり、消失ではない。
`PutEvents`はエントリ単位で成否を返すため、成功したエントリだけ`published_at`を更新し、
失敗したエントリは次回ポーリングで自然に再試行される。

### 3. サービス境界とOwnershipは「Viewスキーマへのwill」を起点に決める

- **account-serviceの所有物**: コマンド処理・DSQL書き込み・Outbox Relay(Scheduler+Lambda)・
  EventBridgeへの`PutEvents`とドメインイベントスキーマ(`Event`/`DomainError`)のSchema Registry
  への登録。
- **Query Serviceの所有物**: EventBridge Rule(購読条件)・Query Projector(イベント→view変換)・
  DynamoDB(view格納)・照会API・Viewスキーマそのもの。

Viewを要求するのはWeb/モバイルアプリであり、それに応える責任を負うのはQuery Serviceである。
したがってViewスキーマ・変換ロジック・購読条件(どのイベント種別が必要か)はすべてQuery Service
の関心事であり、account-serviceは「誰が何を必要としているか」を一切知らずに、自分のドメイン
イベントスキーマを発行するだけに徹する。

一方、イベントスキーマ自体(何を発行するか)は発行元が知っているべきものであり、Schema Registry
への登録はaccount-service側の所有物とする。Query Serviceは「発行されると契約されているイベント」
を購読し、その範囲内で必要なviewを組み立てるよう努める、という位置づけになる。Query Serviceが
必要とするデータが、今publishされているイベントの中身だけでは満たせない場合は、(1)Query Service
が自分のIaCでRuleを追加する、(2)account-serviceへイベントスキーマの拡張を依頼する、の両方が
必要になる——Query Serviceは自分の意思だけでは新しいデータを作り出せない。この非対称性(View
スキーマの決定権はQuery Service、ドメインイベントスキーマの決定権はaccount-service)を認識して
おくことが、セルフサービス方式が機能する前提になる。

このマイルストーンでは単一CDKスタック・単一リポジトリのPoCゆえに物理的には同じ場所にコードを
置くが、コード上のコメントで上記のOwnershipを明記し、将来別リポジトリに分割する際の境界線として
機能させる。

(ADR-0001の「購読ルール…も発行側チームが自分たちのIaCで定義する」という記述は、この検討を経て
不正確と判断し訂正した。Ruleは購読側(Query Service)が自分のIaCで定義する。)

### 4. Viewはevent自身の情報だけから導出し、DynamoDBの1アイテム=レスポンスそのものとする

`account-domain::Account::evolve`はeventの情報だけから結果の`AccountState`を決定し、呼び出し前の
状態(`self`)を参照しない。この性質を利用し、Query Projectorはプレースホルダーの`Account`を
経由して`evolve`を呼び出し、状態遷移ロジックを複製しない(`projection::view_from_event`)。

DynamoDBのアイテムは`accountId`(PK)・`view`(JSON文字列、Query APIのレスポンスそのもの)・
`lastEventAt`/`lastEventId`(決定5の冪等性チェック用)を持つ。DynamoDBを選ぶ理由は「キーバリュー
だから」ではなく、「DSQL側の正規化された行をそのまま複製するのではなく、Query APIが返すべき形に
変換してから格納する」ことが目的だからという位置づけにする。

### 5. 冪等な適用はlast-writer-wins方式を採る

アウトボックスはat-least-once配信かつ順序を保証しない。
[DSQL CDCの公式ガイダンス](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/cdc-streams.html)
が推奨する方式(受信側が保持するタイムスタンプより新しい場合のみ上書きする)をそのまま踏襲し、
DynamoDBの`ConditionExpression`(`attribute_not_exists(accountId) OR lastEventAt < :occurredAt`)
で実現する。条件不成立(古い/重複したイベント)はエラーではなく正常系として扱う——最終的に
last-writer-winsで正しい状態に収束する。

### 6. Query APIはLambdaを介さず、API Gateway REST APIからDynamoDBへ直接統合する

書き込み経路で将来行う予定の「API Gateway→SQS直接統合」と同じ思想(VTLでAWSサービスに直結)で
揃え、「書き込みはSQSへ直結、読み取りはDynamoDBへ直結」という対称性を持たせる。HTTP APIではなく
REST APIを使うのは、AWSサービスへの直接統合(VTL)がREST API限定の機能のため。DynamoDBの
`GetItem`は見つからなくてもHTTP 200・空ボディを返すため、レスポンスVTLで`$.Item`の有無を判定し
404への変換を行う。

GraphQL/AppSyncも検討した。Query Serviceが将来複数の発行元(Transfer等)を横断的に集約する段に
なれば「複数の異なるバックエンドを単一グラフで束ねる」という強みが活きるが、現時点は単一クエリ
形状の検証が目的のため見送った。

### 7. EventBridge Pipesは不採用

検討したが構造的に不適合と判断した。Pipesのソースは
[DynamoDB Streams/Kinesis/SQS/Amazon MSK/Amazon MQに限られ、EventBridgeバス自体はソースにできない](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes.html)。
ターゲットも[通常のRuleと同じ約20種類](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-event-target.html)
で、DynamoDBへの書き込みはネイティブターゲットに含まれない。したがって「EventBridgeで受けた
イベントをDynamoDBのview形状に変換して書く」という今回の用途にはそもそも適用できない。

### 8. 書き込み経路のAPI Gatewayは次のマイルストーンへ先送り

API Gateway→SQS直接統合は枯れたAWSパターンで技術的リスクが低く、後回しにしても損失が小さいと
判断した。次のマイルストーンで着手する。

## 結果整合性のトレードオフ

EventBridge Schedulerの下限が1分であるため、コマンドがDSQLへコミットされてからQuery Serviceの
viewに反映されるまで最大約1分の遅延が生じる。これは[[0001-service-boundaries-and-event-driven-integration]]
が元々認めていた結果整合性のトレードオフ(「口座に反映されたはずの取引がまだ照会に出ない」という
UXへの説明責任)の実測値である。

## 却下した代替案

- **DSQL CDC(Kinesis配信)**: コスト方針と非互換のため不採用(決定1)。
- **コミット直後に直接PutEvents(アウトボックスなし)**: `PutEvents`失敗時にイベントが永久に
  失われるリスクがあり、ADR-0002の「サイレントなデータロスを許さない」方針に反するため不採用。
- **account-service自身の同期GET**(`GET /accounts/{id}`がDSQLを直接SELECTする): 「すべて
  API経由、DSQL直接照会は不可」という方針のもとQuery serviceに一本化し、廃止した。
- **別のDSQLクラスタを読み取りモデルに使う**: コスト的には排除されないが、境界づけられた
  コンテキストごとに適切なデータ形状のストアを選ぶという対比を見せる意図でDynamoDBを採用した
  (決定4)。
- **EventBridge Pipes**: 決定7の理由により不採用。
- **GraphQL/AppSync**: 決定6の理由により今回は見送り。

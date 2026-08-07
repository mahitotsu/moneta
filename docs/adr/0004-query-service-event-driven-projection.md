# ADR 0004: Query serviceとイベント駆動連携の実証(アウトボックス+EventBridge+DynamoDB読み取りモデル)

## ステータス

Accepted。account-service側のアウトボックス(`persistence.rs`・`outbox.rs`・
`src/bin/account-outbox-projector.rs`)とQuery Service側(`projection.rs`、
`src/bin/query_projector.rs`)の実装、および`infra/lib/account-pipeline-stack.ts`の
EventBridge/DynamoDB/API Gateway定義に直接反映する。永続化層はDynamoDBを前提とする
([[0013-migrate-account-service-off-aurora-dsql]])。

## コンテキスト

[[0001-service-boundaries-and-event-driven-integration]]が提案した「イベント駆動でのサービス間
連携」を実装・検証する。照会は「マイクロサービス前提で他サービスのストアへの直接照会は不可、
すべてAPI経由」という方針のもと、Query serviceを実装し、それを唯一の照会経路とする。

## 決定

### 1. トランザクショナルアウトボックスをDynamoDB Streams駆動で実現する

`account_events`テーブル(追記専用のイベントログ、[[0013]])にDynamoDB Streamsを有効化し、
`account-outbox-projector`Lambdaがストリームをトリガーに直接`PutEvents`する、業務レベルの
トランザクショナルアウトボックスを採る。

DynamoDB Streamsは稼働の有無に関わらない時間課金を持たず、Lambdaトリガー経由の読み取りは
無料である([AWS公式ドキュメント](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html)で
確認済み)。「稼働していないときは課金されない」という本PoCのコスト方針とも合致する。
同一アイテムへの変更順序が保証されるため([[0012-transfer-customer-api-and-status-query]]決定1で
確認済みの内容と同じ)、ポーリング間隔に起因する反映遅延も生じない。

### 2. `PutEvents`失敗時はストリームレコードを再試行させ、成功するまでイベントを失わない

`account-outbox-projector`は`PutEvents`が失敗したイベントについて例外を投げてLambda呼び出し
自体を失敗させる。DynamoDB Streamsのevent source mappingは、関数呼び出しが失敗すれば
（設定した再試行回数の範囲で）同じストリームレコードを再試行するため、「処理済みにする」操作は
Lambda呼び出しの成功と結びついたままになり、`PutEvents`が失敗した状態のままイベントが
失われることはない。[[0002-sqs-message-lifecycle-and-error-classification]]が確立した
「サイレントなデータロスを許さない」という設計思想をここでも踏襲する。`PutEvents`はエントリ
単位で成否を返すため、バッチ中の一部だけが失敗した場合は、失敗したエントリだけを再試行対象
として例外を投げる。

再試行回数を使い切ってなお解消しない持続的な障害に対しては、event source mappingの
`onFailure`送信先を設定し、運用側の検知に委ねる。event source mappingの再試行設定・
`onFailure`送信先の具体的な値は実装時にAWS公式ドキュメントで確認する
([[verify_aws_specs_before_implementing]])。

### 3. サービス境界とOwnershipは「Viewスキーマへのwill」を起点に決める

- **account-serviceの所有物**: コマンド処理・DynamoDB書き込み・Outbox投影(DynamoDB Streams+
  Lambda)・EventBridgeへの`PutEvents`とドメインイベントスキーマ(`Event`/`DomainError`)の
  Schema Registryへの登録。
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
`lastEventAt`/`lastEventId`(決定5の冪等性チェック用)を持つ。account-service側の`accounts`
テーブル(正規化された1口座1アイテム、[[0013-migrate-account-service-off-aurora-dsql]])を
そのまま複製するのではなく、Query APIが返すべき形に変換してから格納することが目的である。

### 5. 冪等な適用はlast-writer-wins方式を採る

EventBridgeへの発行はat-least-once配信であり、また`account_events`テーブルの複数の項目
(=複数のイベント)がDynamoDB Streamsの別々のシャードで並行に処理されうるため、Query
Projectorへの到達順序はイベントの発生順序と一致するとは限らない。そのため、受信側が保持する
タイムスタンプより新しい場合のみ上書きする、という方式を採る。DynamoDBの`ConditionExpression`
(`attribute_not_exists(accountId) OR lastEventAt < :occurredAt`)で実現する。条件不成立
(古い/重複したイベント)はエラーではなく正常系として扱う——最終的にlast-writer-winsで
正しい状態に収束する。

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

DynamoDB Streams駆動のため、コマンドが`accounts`/`account_events`へコミットされてから
Query Serviceのviewに反映されるまでの遅延は近リアルタイム(概ね秒未満〜数秒)になる見込みで
あり、正確な値は実装・実測で確定させる([[0013-migrate-account-service-off-aurora-dsql]])。
遅延がゼロになるわけではなく、[[0001-service-boundaries-and-event-driven-integration]]が
元々認めていた結果整合性のトレードオフ(「口座に反映されたはずの取引がまだ照会に出ない」という
UXへの説明責任)自体は引き続き成立する。

## 却下した代替案

- **コミット直後に直接PutEvents(アウトボックスなし)**: `PutEvents`失敗時にイベントが永久に
  失われるリスクがあり、ADR-0002の「サイレントなデータロスを許さない」方針に反するため不採用。
- **account-service自身の同期GET**(`GET /accounts/{id}`がaccount-serviceのテーブルを直接
  読む): 「すべてAPI経由、他サービスのストアへの直接照会は不可」という方針のもとQuery
  serviceに一本化し、廃止した。
- **EventBridge Pipes**: 決定7の理由により不採用。
- **GraphQL/AppSync**: 決定6の理由により今回は見送り。

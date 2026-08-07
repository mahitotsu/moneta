# ADR 0013: account-serviceの永続化ストアにDynamoDBを採用する

## ステータス

Accepted。`crates/account-service`・`infra/lib/account-pipeline-stack.ts`に実装済みで、
実デプロイ・E2Eスイート(`e2e/`、20スイート35テスト)で検証済み。
[[0002-sqs-message-lifecycle-and-error-classification]]・
[[0004-query-service-event-driven-projection]]の記述もこの決定に合わせて更新済み。
[[0005-automated-schema-migration-custom-resource]]は対象が消滅したため削除済み。

## コンテキスト

account-serviceは`Account` aggregate(残高・凍結・解約のライフサイクル、`account-domain`)を
1つの永続化ストアに保持する。SQS FIFOメッセージ処理は[[0002]]の設計により「1メッセージにつき
1つの原子的な書き込み」という単位で行われ、その書き込みは (a) 集約の状態更新、(b) 発行イベントの
記録(トランザクショナルアウトボックス、[[0004]])、(c) 冪等性ログの記録、を同時にコミットする
必要がある。

account-serviceが実際に必要とするデータアクセスパターンは以下に尽きる。

- `account_id`をキーとした単一集約の読み書き(テーブル間のJOINは発生しない)。
- 上記3つの書き込みをまとめた原子性。複数集約にまたがるトランザクションは不要——複数の
  `Account`にまたがる操作(送金)はTransfer serviceのサガに委ねる設計になっている([[0001]]・[[0010]])。
- 同時更新の検出(楽観的並行性制御)。
- 業務ルールの検証はaccount-domainのアプリケーション層(`Account::apply`/`evolve`)で完結し、
  DB側の制約機能(CHECK/FOREIGN KEY等)には委ねない。
- 照会は専用のQuery API経由のみで、ストアへの直接SQL照会は行わない([[0004]])。

## 決定

### 1. ストア: DynamoDB

`accounts`(1アイテム=1口座)・`account_events`(追記専用のイベントログ、アウトボックス)・
`processedMessages`(冪等性ログ)の3テーブルをDynamoDBに置く。

上記のデータアクセスパターンはいずれも「単一パーティションキーでの読み書き」「複数アイテムに
またがる原子的書き込み」「条件付き書き込みによる楽観ロック」に収まり、DynamoDBの`GetItem`/
`TransactWriteItems`/`ConditionExpression`で過不足なく満たせる。query-service([[0004]])・
transfer-service([[0010]])が同種の要件(1アイテム=1集約、楽観ロック、投影)を既に
DynamoDBで満たしており、技術選択を全サービスで揃えられる。

**却下した代替案: Aurora DSQL。** account-serviceが必要とするデータアクセスパターンは
JOIN・CHECK/FOREIGN KEY制約・直接SQL照会のいずれも含まず、DSQLの関係モデル固有の機能を
活かす場面がない。一方でDSQLは、SAVEPOINT非対応・DDLは1文ごとに個別トランザクションが必須・
専用のスキーマ移行の仕組みが要る、といった制約を伴う。要件が求めない機能のためにこれらの
制約を受け入れる理由がないため不採用とする。

### 2. `accounts`: `version`属性による楽観ロック

パーティションキーは`accountId`。属性は`ownerId`/`status`/`balance`/`frozenReason`/
`frozenAt`/`closedAt`(`crates/transfer-service/src/persistence.rs`の`saga_to_item`/
`item_to_saga`と同じ「DBアイテム⇄ドメイン型の変換はここだけに置く」流儀で、
`account_domain::AccountState`との対応を`persistence.rs`の`item_to_state`/`state_to_item`に
閉じ込める)。

楽観ロックは`version`という数値属性を新設し、書き込みごとにインクリメントする。これは
[AWS公式ドキュメント](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-optimistic-locking.html)
が明示する標準パターンであり、`ConditionExpression: "#v = :expectedVersion"`により、読み込んだ
時点から状態が変わっていれば`ConditionalCheckFailedException`で書き込みが失敗する。条件不成立
時の自動リトライはDynamoDB自身は行わないため、アプリケーション層で最大3回・指数バックオフ+
ジッターのリトライを行う。「リトライして解消するインフラ起因の失敗」と「リトライしても結果が
変わらないDomainError」を区別する[[0002]]決定1の分類はそのまま踏襲し、判定対象を
`ConditionalCheckFailedException`に置き換える。

**却下した代替案: `TransferSagaTable`の`advance_saga_state`と同じ「特定フィールド(`state`)の
等値条件」方式。** `AccountState`は`balance`・`status`・`frozen_reason`等、複数のフィールドが
独立に変化しうるenumであり、単一フィールドの等値条件では「読み込んだ後に他の書き込みで
元に戻った」場合を検出できない(ABA問題)。数値`version`はどのフィールド変化でも確実に検出
できるため、こちらを採る。

### 3. `account_events`(アウトボックス): DynamoDB Streams駆動の投影

新テーブルは追記専用のイベントログとして、パーティションキー`eventId`(UUID)で持つ。
`accountId`/`kind`/`payload`/`createdAt`/`correlationId`を格納する。accounts更新・イベント
挿入・`processedMessages`記録は`TransactWriteItems`で1回の原子的な書き込みにまとめる。

このイベントテーブルにDynamoDB Streamsを有効化し、[[0012-transfer-customer-api-and-status-query]]
で採用した`transfer-status-projector`と同じ形の投影Lambda(`account-outbox-projector`)が
ストリームをトリガーに直接`PutEvents`する。DynamoDB Streamsは同一アイテムへの変更順序を保証し(AWS公式ドキュメントで
確認済み)、Lambdaトリガー経由の読み取りは無料でアイドル時の固定費もない([[0012]]決定1と
同じ根拠)。書き込みから読み取りモデルへの反映は近リアルタイム(概ね秒未満〜数秒)になる
見込みだが、正確な数値は実装・実測で確定させる([[verify_aws_specs_before_implementing]])。

**却下した代替案: EventBridge Schedulerによる定期ポーリング(未発行フラグを検索し、
`PutEvents`する方式)。** [[0004]]決定1と同じ理由(Kinesis配信のような時間課金が存在する
ソースに対しては、ポーリング式アウトボックスがコスト面で合理的)はDynamoDB Streamsには
当てはまらない——時間課金がなく、順序も保証されるため、ポーリングを挟む理由がない。また
ポーリング間隔の下限(EventBridge Schedulerは1分)がそのまま結果整合性の窓の下限になって
しまうため、Streams駆動の方が反映速度の面でも優れる。

### 4. スキーマ管理: CDKの`dynamodb.Table`宣言のみ

DynamoDBはスキーマレスであり、テーブル定義はCDKの`dynamodb.Table`宣言そのものが単一の
真実源になる(query-service・transfer-serviceの各テーブルと同じ)。

**却下した代替案: 専用のスキーマ・IAM自動適用の仕組み(CDK Custom Resource)。**
DDL文やロール・grantの事前適用が必要なストアであれば有用だが、DynamoDBはテーブル・IAMロールを
CDKのリソース宣言だけで完結でき、デプロイ時に追加で適用すべきスキーマが存在しない。導入する
理由がないため不採用とする。

### 5. 実機検証で判明: `TransactWriteItems`のIAM認可は`dynamodb:TransactWriteItems`だけでは足りない

実デプロイでaccount-serviceを呼び出したところ、口座開設が毎回`AccessDeniedException`
(`... is not authorized to perform: dynamodb:PutItem on resource: .../moneta-processed-messages
because no identity-based policy allows the dynamodb:PutItem action`)で失敗した。
CDK synthテストは通っていたため、テスト側の見落としではなく、想定していたIAMモデル自体が
誤りだった。

DynamoDBの`TransactWriteItems`は、呼び出し全体に対する`dynamodb:TransactWriteItems`アクションと、
各`TransactItem`が実際に行う個別アクション(`Put`→`dynamodb:PutItem`、`Update`→
`dynamodb:UpdateItem`、`ConditionCheck`→`dynamodb:ConditionCheckItem`)の**両方**をIAMが要求する。
`accountsTable.grant(fn, "dynamodb:TransactWriteItems")`のように`TransactWriteItems`だけを
grantしても、その中の`Put`/`Update`/`ConditionCheck`個別のアクションが許可されていなければ
拒否される。「`TransactWriteItems`権限があれば中身のPut/Updateも包含されるはず」という直感的な
推測は誤りであり、公式ドキュメントの一般的な記述だけを読んでいても気づけなかった
([[verify_aws_specs_before_implementing]]と同じ教訓)。

対処として、`accountsTable`には`grantReadWriteData`(`GetItem`+`PutItem`/`UpdateItem`等)+
`TransactWriteItems`+`ConditionCheckItem`を、`accountEventsTable`/`processedMessagesTable`には
`grantWriteData`(`PutItem`等)+`TransactWriteItems`を、それぞれ両方grantする
(`infra/lib/account-pipeline-stack.ts`)。

## トレードオフ

- **`TransactWriteItems`は1トランザクションあたり最大100項目・4MBという上限がある**が、
  現在の使用形態(1メッセージ=accounts 1項目+account_events 1項目+processedMessages 1項目、
  最大3項目)には十分な余裕がある。
- **DynamoDBの`ConditionExpression`ベースのOCCは、SQLSTATEのような細かい障害コード体系を
  持たない**(`ConditionalCheckFailedException`か、それ以外(スロットリング・タイムアウト等の
  インフラ障害)かの二値に近い)。[[0002]]決定1の「DomainError vs インフラ障害」という大枠の
  分類は保てるが、インフラ障害側のサブ分類の粒度はこれより粗くなる。このPoCの検証目的に
  おいては許容範囲と判断する。

## 検証結果

実デプロイ後、`account_events`への書き込みから照会API(`GET /accounts/{id}`)への反映までを
手動測定したところ、数秒程度で収束した(旧EventBridge Scheduler方式の「最大約1分」という
上限から大幅に短縮)。`e2e/`のE2Eスイート(20スイート・35テスト)は全件成功し、
`support/poll.ts`の`waitFor`をデフォルトタイムアウト30秒・1秒間隔に簡素化した状態(加速用の
`triggerRelay`フックは削除、[[0004]]・e2e/README.md参照)でも安定して収束することを確認した。
決定5に記載したIAM権限の不足は、この検証の過程で実際に発見・修正したものである。

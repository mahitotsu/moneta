# ADR 0005: スキーマ適用をCDK Custom Resourceで自動化する

## ステータス

Accepted。`crates/account-service/src/bin/schema_migrator.rs`と
`infra/lib/account-pipeline-stack.ts`の`AccountSchemaMigratorFunction`/`AccountSchemaMigration`
に直接反映する。`infra/scripts/apply-schema.sh`は削除した。

## コンテキスト

これまでスキーマ適用(`schema.sql`のDDL・`account_service_app`ロールの作成・各Lambda実行ロールへの
IAM GRANT)は、`cdk deploy`とは別に`infra/scripts/apply-schema.sh`を手動実行する運用だった。

[[0004-query-service-event-driven-projection]]でoutbox relay Lambdaを追加した際、この手動運用が
実際に問題を起こした。outbox relay用のロールをapply-schema.shの引数に追加する変更はコードには
入れたが、実AWSへのデプロイ後にこのスクリプトを(新しい引数で)再実行するのを忘れたまま
「デプロイ完了」として扱ってしまい、outbox relay LambdaがDSQLへの接続で
`access denied`(SQLSTATE `28000`)を出し続ける状態に気づかず放置していた。`cdk deploy`の成功と
スキーマ適用の完了が別々の手順である以上、この種の「デプロイはできたがスキーマ/権限が古い」という
不整合はいずれまた起きる。デプロイ自体にスキーマ適用を組み込み、手動手順を無くす。

## 決定

### 1. CDK Custom Resource(Provider Framework)でLambdaベースの移行処理を実装する

`aws-cdk-lib/custom-resources`の`Provider`+`aws-cdk-lib/core`の`CustomResource`を使い、
`AccountSchemaMigratorFunction`(Rust、`account-schema-migrator`バイナリ)を
CloudFormationのCreate/Updateイベントで呼び出す。このLambdaは`dsql:DbConnectAdmin`
(通常のLambdaが使う`dsql:DbConnect`とは別のIAMアクション)でDSQLへadmin接続し、
`schema.sql`の適用・`account_service_app`ロールの作成・引数で渡された各Lambda実行ロールへの
`AWS IAM GRANT`を行う。

`aurora-dsql-sqlx-connector`は接続URLのユーザー名が`admin`だと自動的に
`db_connect_admin_auth_token`を使う実装になっている(`src/token.rs`で確認)ため、
account-service・outbox-relayの既存Lambdaと同じ`aurora_dsql_sqlx_connector::pool::connect`を
そのまま再利用でき、新しいDB接続方式を持ち込む必要がなかった。

### 2. 再トリガーは`ResourceProperties`のハッシュ値で行う

CloudFormationのCustom ResourceはUpdateイベントを、`ResourceProperties`が変化したときにだけ
発火する——Lambdaの中身(コード)が変わっただけでは発火しない。このため、`schema.sql`の内容と
グラント対象のLambdaロールARN一覧を連結してSHA-256ハッシュを取り、`Trigger`プロパティとして
CustomResourceに渡す(CDK側の`crypto.createHash`で計算、Lambda側ではこの値自体は使わない)。
どちらかが変わればCloudFormationがUpdateとみなし、Migratorが再実行される。

### 3. べき等性の担保方針

- `CREATE TABLE IF NOT EXISTS`・`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`は
  [公式ドキュメント](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.md)
  ([ALTER TABLE](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.md)側も)
  でサポートを確認済みなので、`schema.sql`自体をこの形で書く(単一の真実源——Migratorは
  `include_str!`でこのファイルをそのまま埋め込んで実行する。手で複製したDDL文をコードに
  持たない)。
- `CREATE INDEX ASYNC`が`IF NOT EXISTS`をサポートするかはドキュメントで確認が取れなかったため、
  SQL側では付けていない。
- `CREATE ROLE`・`AWS IAM GRANT`にはべき等な構文が無い(DSQLはPL/pgSQLの`DO`ブロックを
  非サポートのため、SQL側で例外を握りつぶす書き方もできない)。
- 上記の理由により、Migrator側で「既に存在する/既に付与済み」に類するエラー
  (SQLSTATE `42710`/`42P07`/`42701`/`42P06`/`42723`、またはメッセージに"already exists"/
  "already granted"を含むもの)だけを無視し、それ以外のエラーは伝播させてCustom Resourceを
  FAILEDにする(`schema_migrator.rs`の`is_already_applied`)。想定外のエラーを握りつぶさない、
  というADR-0002以来のこのプロジェクトの一貫した方針を踏襲する。

### 4. `Delete`イベントでは何もしない

DSQLクラスタ自体がスタック削除時に一緒に削除されるため、スキーマ側で明示的に後始末する
意味がない。

### 5. account-service・outbox relay Lambdaとの明示的な順序付けはしない

当初`fn.node.addDependency(schemaMigration)`のようにCDKの依存関係で明示的に順序付けよう
としたが、`AccountSchemaMigration`の`LambdaRoleArns`プロパティが`fn`のIAM Role(CDKが
`fn`のコンストラクト内に自動生成する子リソース)のARNを参照しているため、
`AccountServiceFunctionServiceRole -> AccountSchemaMigration -> AccountServiceFunctionServiceRole`
という循環依存になり`cdk synth`が失敗した。`fn`単位ではなくSQSのEvent Source Mapping等
より細かい粒度に依存先を絞ることも検討したが、既にデプロイ済みのリソースを再構成するリスクの
わりに得られる利益(デプロイ直後の一時的なaccess deniedを避けられるだけ)が小さいと判断し、
明示的な順序付けは行わないことにした。同時にデプロイされてこの2つのLambda
(DSQLに直接アクセスする唯一の2つ、[[0004-query-service-event-driven-projection]]の
サービス境界を参照)が移行完了前に呼ばれた場合は、ADR-0002の分類通りインフラ起因の失敗として
リトライに委ね、移行完了後に自然に解消させる。Query Projector・照会APIはDSQLに一切触れないため
この考慮自体が不要。

### 6. DDL自体もAurora DSQLのOCC競合(SQLSTATE `OC001`)でリトライが必要

[[0010-transfer-service-saga]]で`account_events`に列を追加した際の実デプロイで、
`AccountSchemaMigration`が「schema has been updated by another transaction (OC001)」で
FAILEDになる不具合を実際に起こした。[[0002-sqs-message-lifecycle-and-error-classification]]の
コンテキストで触れている通り、Aurora DSQLのOCC競合はデータ競合(`OC000`)だけでなくスキーマ競合
(`OC001`)も含む——本ADR起草時点では書き込みパス(決定6の`retry_on_occ`)にしかこの対処を
入れておらず、複数のDDL文を連続実行する`schema_migrator.rs`の`run_idempotent`にはリトライが
一切無かった。これが原因だった。

`aurora-dsql-sqlx-connector`の`retry_on_occ`は行レベルのトランザクションに限らず、任意の
`Result<T, sqlx::Error>`を返す非同期クロージャを対象にできるため、`run_idempotent`の
DDL実行(「既に適用済み」の判定を含む)全体を同じ`retry_on_occ`(デフォルト設定: 最大3回、
指数バックオフ+ジッター)でラップした。書き込みパスと同じ機構を、DDLという別の文脈にも
そのまま再利用できた。

## 却下した代替案

- **手動スクリプトのまま(現状維持)**: 今回の不具合そのものであり、不採用。
- **`AwsCustomResource`(CDK標準の、SDK呼び出しを宣言的に書けるCustom Resource)**: DSQLへの
  admin接続・複数のDDL文の順次実行・アプリケーション側でのべき等性判定という手続き的な処理には
  向かない(SDK呼び出し1つを宣言するための機能であり、任意のロジックは書けない)ため不採用。
- **`cdk deploy`後のCI/CDパイプラインでスクリプトを自動実行**: このPoCにはCI/CDパイプライン
  そのものが無く、導入は本題を超えたスコープ拡大になるため不採用。デプロイという単一の操作に
  スキーマ適用を含めてしまう方が、このPoCの規模には合っている。

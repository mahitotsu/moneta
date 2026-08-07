# ADR 0008: Query Serviceを別Rustクレートへ分離する

## ステータス

Accepted。`crates/query-service`(新規)と`crates/account-service`/`crates/account-domain`
の変更、`infra/lib/account-pipeline-stack.ts`の`rustLambdaCode`呼び出しに直接反映する。

## コンテキスト

[[0001-service-boundaries-and-event-driven-integration]]は「Account ServiceとQuery
Serviceは別マイクロサービス」と定義しているが、Web UIマイルストーンでの実装確認中に、
Query Serviceのコード(`projection.rs`・`bin/query_projector.rs`)が
`account-service`クレートに同居しており、境界がコードコメント上の`[Query Service所有]`
アノテーションだけで表現されていることが判明した。[[0004-query-service-event-driven-projection]]
決定3は「このマイルストーンでは単一CDKスタック・単一リポジトリのPoCゆえに物理的には同じ
場所にコードを置くが、コード上のコメントで上記のOwnershipを明記し、将来別リポジトリに
分割する際の境界線として機能させる」と明記しており、この「まだ分割していない」状態を
本ADRで解消する。

これは見た目の問題だけでなく実害があった:

- `account-query-projector`(DynamoDBへの書き込みのみ行うLambda)が、同一クレートである
  以上`account-service`のCargo.tomlに書かれた全依存関係(account-service自身の永続化・
  EventBridge発行に使うクレート一式)を巻き込んでビルドされていた。Query Serviceは
  元々account-serviceの書き込み側ストアには一切アクセスしない設計
  ([[0004-query-service-event-driven-projection]]:「account-serviceの内部ストアへは
  一切アクセスしない」)なのに、それを保証する仕組みがコード上に無かった。
- 境界がコンパイラで強制されていなかった。同一クレート内である以上、Query Service側の
  コードが`persistence.rs`(account-service固有の書き込み側コード)へ誤って依存することを
  Rustの型システムは防げない。これは[[0003-domain-service-crate-boundary]]が
  `account-domain`/`account-service`の境界について採用した論拠(「Rustの型システムに
  よって強制される境界であり、規約ではない」)と同じ理由で、Query Serviceにはまだ
  適用されていなかった。

## 決定

### 1. `crates/query-service`という新しいクレートを作る

`projection.rs`(view変換ロジック、既にaccount-domainのみに依存していたためほぼ無変更で
移動できた)と`bin/query_projector.rs`(Lambdaバイナリ`account-query-projector`)を移動
する。`Cargo.toml`の依存は`account-domain`・`aws-config`・`aws-sdk-dynamodb`・
`aws_lambda_events`・`lambda_runtime`・`serde_json`・`tokio`・`tracing`系のみとし、
**`aws-sdk-eventbridge`を含めない**。これにより「Query Serviceはイベントの購読しかできず、
自分でEventBridgeへ発行することはできない」という主張がCargo.tomlの記述そのものによって
コンパイル時に保証されるようになった(`cargo tree -p query-service`でこれが依存グラフに
一切現れないことを確認済み)。account-service固有の永続化コード(`persistence.rs`)への
依存も、query-serviceが`account-service`クレート自体に依存していないことで構造的に
防がれる。

### 2. `EventEnvelope`を`account-domain`へ移す

`query_projector.rs`が`account-service`クレートへ依存していた唯一の箇所は
`use account_service::{outbox::EventEnvelope, projection};`だった。`EventEnvelope`
(発行側`account-outbox-relay`と購読側`account-query-projector`の双方がやり取りする
契約型)はAWS/DB依存を一切持たない素の`Serialize`/`Deserialize`構造体
(`Uuid`・`OffsetDateTime`・`serde_json::Value`のみ)だったため、`account-domain`
(既にゼロ依存の契約クレート、`Event`/`Command`と同じ立ち位置)へ移した。これにより
query-serviceクレートは`account-service`クレートに一切依存せずにこの契約型を共有できる。
`account-domain`の「AWS/DB依存ゼロ」という制約([[0003-domain-service-crate-boundary]])
は壊れない(`serde_json`はAWS/DB固有の依存ではない)。

`account-domain`の`serde_json`は`EventEnvelope::data: Value`のために
`[dev-dependencies]`から`[dependencies]`へ昇格した。

### 3. CDKビルドヘルパーをパッケージ名で引数化する

`rustLambdaCode`ヘルパー(`account-pipeline-stack.ts`)は`-p account-service`を
ハードコードしていたため、`(packageName, binaryName)`の2引数に変更した。4バイナリの
うち`account-query-projector`だけが`-p query-service`でビルドされ、残り3つ
(`account-service`・`account-outbox-relay`・`account-schema-migrator`)は引き続き
`-p account-service`。IAM権限・EventBridge Rule・DynamoDBテーブル等のCDKリソース定義
自体は変更していない(Lambdaの中身のビルド元パッケージが変わっただけ)。

## 却下した代替案

- **`EventEnvelope`を第3の共有クレート(例: `crates/event-contracts`)に切り出す**:
  「発行側と購読側の契約は両者から独立した場所に置くべき」という理屈は立つが、
  query-serviceは元々`account-domain`に(`AccountId`/`Event`のために)依存しており、
  新しい依存を1つ増やすだけの価値が無いと判断した。`account-domain`は既に「ゼロ依存の
  契約クレート」という役割を担っており、`EventEnvelope`もその役割にそのまま合致する。
- **現状維持(コメントだけの境界)**: 実害(不要な依存関係の巻き込み、型システムで
  強制されない境界)がある状態を追認することになり、[[0003-domain-service-crate-boundary]]
  自身の論拠と矛盾するため不採用。

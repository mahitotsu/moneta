# ADR 0003: `account-domain`と`account-service`のクレート境界

## ステータス

Accepted

## コンテキスト

`account-domain`（`Account` aggregate、`Command`/`Event`/`DomainError`、`apply`/`evolve`）と
`account-service`（Lambdaハンドラー、SQS処理、DSQL永続化）を別クレートに分けている。
実装を進める中で、この境界の引き方について2つの問いが出た。

1. このクレート分割は本当に必要か（[[0001-service-boundaries-and-event-driven-integration]]の
   「serviceとdomainで分離する必要があるのですね？」という確認）
2. 永続化処理だけでなく、業務ロジックも全て`account-domain`に寄せるべきか

## 決定

### 1. クレートを分ける理由

`account-domain`はAWS SDK・`sqlx`・`lambda_runtime`など、インフラ固有の依存を一切持たない。
これはRustの型システムによって強制される境界であり、規約ではない——
`account-domain`のCargo.tomlにこれらのクレートを追加しない限り、ドメインロジックの中で
誤ってSQSやDBの型を扱うことはコンパイルレベルで不可能になる。

利点：
- ドメインのテストはtokioランタイムもモックDBも不要で、高速に回る
  （実測：9テストが0.00秒台で完了）
- インフラ層（Lambda→別の呼び出し方式への変更など）がドメインロジックのテストに影響しない
- [[0001-service-boundaries-and-event-driven-integration]]の「aggregate≠マイクロサービス」と
  同じ理由で、「業務ルール」と「今それをどう呼び出しているか」は別の関心事として扱う

### 2. 境界線は「AWSかどうか」ではなく「業務ルールかどうか」

`account-service::persistence`には以下が含まれるが、これらは業務ロジックではない。

- **永続化マッピング**：DBの行⇔`AccountState`の変換（`row_to_state`/`state_to_columns`）。
  これは「今回DSQLにこう保存すると決めた」という技術的選択であり、業務ルールではない。
- **手順の調整（オーケストレーション）**：冪等性チェック→現在の状態をロード→
  `Account::apply`を呼ぶ→結果を保存、という手順そのもの。

業務ロジック（残高計算、凍結中は入出金拒否、解約後は全操作拒否等）は100%
`Account::apply`/`evolve`の中にあり、`persistence.rs`はこれらを一切再実装せず、
`account.apply(cmd, now)`を呼び出すだけである。

### 3. リポジトリtrait（ports and adapters）による抽象化は導入しない

教科書的なhexagonal architectureでは、上記の「手順の調整」をさらに`AccountRepository`のような
trait（ポート）として抽象化し、DSQL実装をアダプタとして分離する構成もありうる。そうすれば
手順自体をDBなしでテストでき、将来DBを差し替えても手順コードは変わらない。

**今回はこれを導入しない。** 理由：

- 本PoCはDBを差し替える予定がなく、実装が1つしかない段階でtraitによる抽象化を入れるのは
  「まだ必要になっていない将来の柔軟性のための抽象化」であり、過剰設計にあたる
- 本PoCの位置づけ自体が「組織展開を見据えた参照アーキテクチャ」ではなく「お試し記事」であり、
  技術的妥当性の検証を優先する（[[0001-service-boundaries-and-event-driven-integration]]と同じ前提）

複数の永続化実装を切り替える必要が生じた場合、または手順ロジック自体を実DB/フェイクDBなしで
独立にテストする必要が生じた場合は、この決定を再検討する。

## 却下した代替案

- **単一クレートに全てまとめる**：ドメインロジックにAWS/DB依存が型システムレベルで
  混入しうる状態になり、[[0001-service-boundaries-and-event-driven-integration]]の
  「aggregate≠マイクロサービス」の精神（業務ルールと実行基盤の分離）に反するため不採用。
- **`AccountRepository` traitによるports and adaptersの導入**：正当なDDD/hexagonalの
  発展形ではあるが、現時点で必要性がなく、PoCのスコープを超える過剰設計と判断し不採用。

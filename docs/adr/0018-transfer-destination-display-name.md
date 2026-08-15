# ADR 0018: 振込確認画面の宛先名義に表示用の名前を使う

## ステータス

Accepted。`account-domain`(`Command::Open`/`Event::Opened`)、`account-service`
(`persistence.rs`)、`infra/lib/account-pipeline-stack.ts`(`Open`のVTL、`AccountNumbersTable`・
`AccountNumberQueryApi`)、`query-service`(`account_number_projector.rs`)、`web-ui`の
`TransferForm.tsx`・`api/types.ts`に実装する。[[0015-friendly-account-numbers-and-branch-and-other-bank-placeholder]]決定2/3が導入した`AccountNumberLookup`の`ownerId`フィールドを、
本ADRで`ownerName`に置き換える。

## コンテキスト

ユーザーから、デモデータの送金の宛先確認で表示される「名義」が、アプリの他の画面が表示する
口座名義の書式・体裁と一致していない、という指摘を受けた。調査の結果、振込(furikomi)の
宛先確認ステップ([[0015]]決定6が追加した「支店選択→口座番号入力→検索→名義確認」フロー、
`TransferForm.tsx`)が「宛先名義」として表示していたのは、実は氏名ではなく
`AccountNumberLookup.ownerId`——account-serviceが`accounts`テーブルへ保存している
Cognitoの`sub`(UUID、[[0016-cognito-authentication]]決定3)がそのまま素通しされたものだった。

このシステムには「氏名」に相当するデータがそもそも存在しない。[[0016]]決定1により、Cognitoの
サインアップはユーザー名+パスワードのみで、氏名フィールドを収集していない。一方、
`AppBar.tsx`が「{customerName} 様」として表示しているのは`cognito:username`クレーム
(サインアップ時に選んだユーザー名)であり、この文字列こそがこのアプリの中で唯一の
「人が読める識別名」として機能している。「宛先名義」欄だけがこの慣習を無視してCognitoの
sub(UUID)を出していたため、書式が一致していないように見えた——単なる見た目の不一致ではなく、
内部識別子を顧客向けUI文言にそのまま漏らしていた不具合だった。

## 決定

### 1. `Command::Open`/`Event::Opened`に`owner_name: String`を追加する

`owner_id`(認可判定に使う、[[0011-furikae-furikomi-distinction]]/[[0016]]決定3)とは完全に
独立した、表示専用のフィールドとして追加する。`Account`/`AccountState`側には持たせない
——`evolve`はこの値を一切読まず、`Account`集約の状態にもならない。`account_events`
アウトボックス経由でquery-serviceの`account_number_projector.rs`へ届けるためだけに
`Event::Opened`のペイロードに載せる。

### 2. VTLで`owner_id`と同じ認証済みクレームから注入する(ボディでは受け取らない)

`OpenCommandModel`は既に`initial_balance`以外のプロパティを拒否しており
(`additionalProperties: false`)、`owner_id`は`$context.authorizer.claims.sub`から直接
注入されている([[0016]]決定3)。`owner_name`も同じ理由・同じ形で
`$context.authorizer.claims['cognito:username']`から注入する——クレーム名にコロンを含むため、
AWS公式ドキュメント(apigateway-enable-cognito-user-pool.html)が示す`['claim-name']`の
ブラケット記法が必要で、`.sub`のようなドット記法は使えない。ユーザーが選んだ値である以上、
`initial_balance`と同じく`$util.escapeJavaScript()`でJSON埋め込み時にエスケープする——`sub`と
違い、Cognitoのユーザー名は`"`や`\`を許容しうる文字集合(`[\p{L}\p{M}\p{S}\p{N}\p{P}]+`)で
あるため。

account-service側(`persistence::resolve_owner_id`)は`owner_id`だけを`requested_by`で
上書きする既存の防御多重化をそのまま維持しつつ、`owner_name`はこの上書き対象に含めない
——表示専用データであり認可判定に一切使わないため上書きする理由がなく、そもそも`Open`の
ボディに`owner_name`を受け付ける余地もない(同モデルの`additionalProperties: false`)。

### 3. `account_number_projector.rs`が`AccountNumbersTable`に`ownerName`を書き、`ownerId`は保持するがAPIレスポンスには出さない

内部識別子の`ownerId`(Cognitoのsub)はテーブル項目には引き続き保持する(将来の運用調査に
有用で、書き込みコストもほぼゼロ)が、`AccountNumberQueryApi`の2つのVTLレスポンス
テンプレート(`GET /account-numbers/{accountNumber}`・`GET /accounts/{accountId}/account-number`)は`ownerId`ではなく`ownerName`だけを返す——顧客向けAPIレスポンスから内部識別子を落とす。

### 4. Web UI: `AccountNumberLookup.ownerId`を`ownerName`に置き換える

`TransferForm.tsx`の「宛先名義」表示は`resolvedAccount.ownerName`を参照する。この型は
`AccountView.tsx`の自分の口座番号表示でも使われるが、そちらは`ownerId`/`ownerName`いずれも
表示に使っていなかったため影響はない。`api-e2e`/`ui-e2e`の同型の型定義・アサーションも
揃えて更新する(`api-e2e/support/auth.ts`の`TestIdentity`に`username`を追加し、
`account-number.e2e.test.ts`は`ownerName`をこの値と比較する)。

## トレードオフ

- **「氏名」は依然として存在しない、あくまでユーザー名の転用**: 本ADRは新しい「氏名」属性を
  Cognitoに追加するのではなく、既存の`cognito:username`(サインアップ時のログインID)を
  表示名として使い回している。実際の銀行のように本名を確認する体験の再現ではなく、「UUIDでは
  なく人間が選んだ文字列を見せる」という最小限の修正に留めている——このPoCの検証テーマ
  (イベント駆動アーキテクチャの妥当性)には氏名収集機能そのものは寄与しないため。
- **`Event::Opened`のペイロードが1フィールド増える**: 消費側(`owner_projector.rs`・
  `customer_accounts_projector.rs`)は`..`パターンで既に前方互換だったため無改修で追従できたが、
  `account-domain`のenumが増えるたびにこの手当が要ることに変わりはない([[0011]]が`owner_id`を
  追加したときと同型のコスト)。
- **`ownerId`はテーブルに残るが使われなくなる**: 完全に削除する選択肢もあったが、内部識別子
  として将来の運用調査に使える可能性を残す方を選んだ(トレードオフというより保守的な選択)。

## 却下した代替案

- **「宛先名義」表示自体を削除する**: 内部識別子の漏洩を止める最小の変更だが、[[0015]]決定6が
  この確認ステップに持たせた目的(誤送金防止——支店・口座番号だけでなく名義も見せて確認させる)
  を弱めてしまう。既存の「ユーザー名を人向け表示名として使う」慣習(`AppBar.tsx`)の範囲内で
  正しいデータに差し替える方が確認ステップの意図を保てるため、採らなかった。
- **Cognitoに独立した「氏名」属性を追加する**: サインアップフォームに新しい入力欄を増やし、
  `PostConfirmation`トリガー等で属性を伝播させる必要があり、[[0016]]決定1が意図的に
  「ユーザー名+パスワードのみ」に絞った最小認証UIの範囲を超える。このPoCが検証したいのは
  イベント駆動アーキテクチャであり、氏名収集というドメイン機能の追加ではないため見送った。

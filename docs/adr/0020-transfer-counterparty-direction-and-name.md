# ADR 0020: 送金一覧・詳細に、送受信の方向と相手方の名義を表示する

## ステータス

Accepted。`web-ui`の`TransferListScreen.tsx`・`TransferDetailScreen.tsx`・`index.css`に実装する。
[[0019-transfer-screens-real-account-numbers]]が実在の口座番号を表示するところまでは直したが、
まだ「常に送信者目線」だったこの2画面の設計を、本ADRで受信側にも対応させる。

## コンテキスト

[[0019]]をデプロイした後、ユーザーから「振込について送金先だけでなく、入金(振込を受け取る側)
の場合は送金元の名義も確認できた方がよいのでは。現状それを確認するUIが無いのでは」という
指摘を受けた。調査すると、その通りだった:

- `TransferListScreen.tsx`の各行は常に`toAccountId`(宛先)の情報だけを「〜宛」という
  送信者目線の文言で表示していた。[[0017-server-side-transfer-history]]により振込は受取側の
  「送金」タブにも表示されるが、受け取った側から見るとこの行は「自分の口座宛」という
  無意味な表示になり、肝心の送金元(誰から受け取ったか)が一覧のどこにも出ていなかった。
- `TransferDetailScreen.tsx`は[[0019]]で送金元・送金先とも実在の口座番号を表示するように
  なったが、名義(`ownerName`、[[0018-transfer-destination-display-name]])はどちらの側にも
  出していなかった。

いずれも、`AccountNumberQueryApi`が既に返している`ownerName`を使えば追加のバックエンド変更
無しに直せるデータ不足ではなく、単に「相手方(自分ではない側)がどちらか」を判定する
UIロジックが無かっただけだった。

## 決定

### 1. 「相手方」を`fromAccountId`/`toAccountId`と自分の口座IDの突き合わせで判定する

`getMyAccounts()`(両画面とも`["my-accounts"]`キーで取得——`TransferListScreen.tsx`は既存の
`myAccountsQuery`をそのまま再利用、`TransferDetailScreen.tsx`は新たに取得を追加)が返す
自分の口座ID集合と、送金レコードの`fromAccountId`/`toAccountId`を比較する:

- `fromAccountId`が自分の口座 → 自分が送信者、相手は`toAccountId`
- そうでなければ受信者、相手は`fromAccountId`

この判定はfurikomi・recall(組戻し)の両方に成り立つ——recallは「元の受取人が送金元になって
送り返す」という向きの新規サガ([[0011-furikae-furikomi-distinction]])であり、
`fromAccountId`/`toAccountId`の実体を見る限り同じロジックで正しく扱える(recallを開始した側
から見れば出金、元の送金者から見れば入金として自然に表示される)。furikae(振替)は
送金元・送金先とも常に自分名義なので、この判定自体を行わない(`kind === "furikae"`で除外)。

`myAccounts`がまだ反映されていない間(`data`が`undefined`)は、相手方の判定を行わず
——`toAccountId`側だけを見せる[[0019]]までの表示にフォールバックする——空集合を「自分の口座は
無い」と誤読して全件を「相手方」と判定してしまう事故を避ける。

### 2. `TransferListScreen.tsx`: 送受信をアイコン・色・文言で示す

`TransactionHistory.tsx`が入出金(deposited/withdrawn)に既に使っている`ArrowDownLeft`/
`ArrowUpRight`アイコンと`tx-icon-positive`/`tx-icon-negative`のトーンをそのまま再利用する
(新しい視覚言語を発明せず、アプリ内で入金=緑・出金=赤の意味を統一する)。furikaeは方向の
概念が無いため`Bank`アイコン・neutralトーン。相手方の口座番号ラベルに「(名義)様へ」
(送信)/「(名義)様より」(受信)を付す。

新しいCSS(`.account-card-icon-row`)は、アイコンと`.account-card-main`を1つの子要素にまとめる
だけの薄いラッパーで、`.account-card`自体の既存の2要素`space-between`レイアウト
(`.account-card-side`との間)には影響しない——`AccountListScreen.tsx`など他の`.account-card`
利用箇所は無改修。

### 3. `TransferDetailScreen.tsx`: 相手方の側にだけ名義を併記する

自分の側は自明(AppBarの「○○ 様」で既に見えている)なので出さない。furikomiで自分が送金元なら
送金先の`dd`に、自分が送金先なら送金元の`dd`に、それぞれ「口座番号 / 名義様」の形で名義を足す。
furikaeはどちらの側にも足さない(決定1と同じ理由)。

## トレードオフ

- **`TransferDetailScreen.tsx`にも`getMyAccounts()`呼び出しが増える**: `TransferListScreen.tsx`
  と同じ`["my-accounts"]`キーを使うため、両画面を行き来する典型的な操作順
  (一覧→詳細)ではreact-queryのキャッシュがヒットし、実質的な追加ネットワークコストはほぼ無い。
- **`myAccounts`未反映の間は方向判定そのものをスキップする**: 誤判定([[eventual_consistency_not_a_failure]]の精神で「間違った断定より穏当な保留」を優先)を避けるためだが、
  この間は[[0019]]までの「相手方の判定なし」表示に一時的に戻る——実害はないが、初回表示が
  一瞬粗い表示になりうる。

## 却下した代替案

- **`CustomerTransfersTable`(サーバー側)に「送受信の別」フィールドを追加する**: 表示だけの
  問題であり、`fromAccountId`/`toAccountId`と手元の口座一覧を突き合わせればクライアント側で
  導出できるため、新しいバックエンドデータやマイグレーションを持ち込む理由がない
  ([[0019]]と同じく、フロントエンドのロジック不足が原因でバックエンドは無罪だったケース)。
- **相手方だけでなく自分側にも常に名義を表示する**: 自分の名前は既にAppBarに出ており冗長。
  実害を防ぐ確認価値があるのは相手方の名義だけなので、そちらだけに絞った。

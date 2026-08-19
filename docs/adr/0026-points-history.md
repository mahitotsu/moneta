# ADR 0026: ポイント履歴機能

## ステータス

Accepted。`crates/points-service`(`src/history.rs`新規、`src/persistence.rs`・
`src/bin/command_intake.rs`変更)・`crates/transfer-service`(`src/commands.rs`の`AwardPoints`に
`transfer_id`を追加)・`infra/lib/account-pipeline-stack.ts`(`PointsHistoryTable`新規、
`GET /customers/me/points/history`)・`web-ui/src/components/PointsHistoryScreen.tsx`(新規)・
`AppBar.tsx`(ポイントバッジをボタン化)・`CustomerFlow.tsx`。

cargo test/clippy(全crate)、infra CDK synthテスト(44件)、web-ui vitest(62件)がすべて
green。デプロイ・ライブ検証は次のステップ。

## コンテキスト

[[0025-points-balance-query-api-and-header-display]]でポイント**残高**は可視化したが、
「いつ・何によって増減したか」の履歴は一度も見えるようにしていなかった。account-service/
query-serviceが取引履歴(`AccountHistoryTable`、[[0009]]決定4)・送金履歴
(`CustomerTransfersTable`、[[0017]])という2つの履歴機能を既に持っているのに対し、
ポイントだけが残高のスナップショットしか見せられない非対称な状態だった。

調査の結果、この機能を作るには2つの前提を先に埋める必要があることが分かった:

1. `points-service`の`PointsEventsTable`は`ReservePoints`(fee-serviceが結果を待つ)のときだけ
   書かれる([[0024]]決定6)。**`AwardPoints`(付与)・`RefundPoints`(返却)はこのテーブルへ
   一切書かれない**——`credit_points`は残高更新のみで、記録が残らない設計だった。
2. `AwardPoints`コマンドの配線(`transfer-service`→`points-service`)には`transfer_id`が
   乗っていなかった(`owner_id`/`amount`のみ)。`RefundPoints`には既に乗っている。

## 決定

### 1. 履歴は他サービスを経由させず、points-service自身が直接書く

`account-service`/`transfer-service`の履歴機能(`AccountHistoryTable`/
`CustomerTransfersTable`)はどちらもEventBridge経由の投影(専用Lambda + DynamoDB Streams)
だが、それらは他サービス([[0004]]のquery-service、[[0017]]のtransfer-history-projector)が
**自分の管轄外のデータ**を集約する必要があったための構造だった。ポイント履歴はそうではない
——`points-service`自身が残高を書いているその場で、同じ`TransactWriteItems`に履歴アイテムの
`Put`を1つ追加するだけで完結する。新しいテーブル([[0024]]決定6が言う「アウトボックス」とは
別)は要るが、新しいEventBridge Rule/Lambdaは要らない——[[0024]]決定6の「アウトボックスは
呼び出し元が待つ応答だけに使う」という判断を、「顧客向け記録も、他サービスが消費しないなら
直接書けばよい」まで一貫させた形。

新しい`PointsHistoryTable`(PK=`ownerId`、SK=ゼロ埋めナノ秒タイムスタンプ+`eventId`)は
`AccountHistoryTable`と全く同じソートキー技法を使うが、コードは共有しない
(`points-service`はquery-serviceは元よりaccount-domainにも依存しない、[[0024]]決定1)。
`persistence.rs`の`history_put`が、`reserve_points`(充当)・`credit_points`(付与・返却)の
どちらの`TransactWriteItems`にも1アイテムとして相乗りする。エントリのJSON文字列は
`history.rs`の純粋関数`history_entry`がRust側で組み立て済みのものをそのまま`entry`属性に
持たせ、APIのレスポンスVTLは`#foreach`で連結するだけにする——`account-service`の
`history_entry_from_event`/`listTransactionsIntegration`が確立した「VTLでJSONを組み立てない」
という教訓([[0006]]が実機バグを繰り返し踏んだ経緯)をそのまま踏襲する。

`kind: HistoryKind { Reserved, Awarded, Refunded }`という3値で「増えたか減ったか」を表現する
——`amount`自体は常に非負の増減幅として持つ。`reserved`(手数料充当)だけが減る方向、
`awarded`(振込受取による付与)/`refunded`(送金失敗/補償による返却)はどちらも増える方向。

### 2. `AwardPoints`コマンドに`transfer_id`を追加する

[[0021-account-transfer-cross-links]]が口座履歴↔送金履歴に付けた相互リンクと同じ理由で、
ポイント履歴の各行からも原因の送金の詳細へ辿れるようにする。`RefundPoints`は既に
`transfer_id`を持っていたが、`AwardPoints`は`owner_id`/`amount`のみだった——
`transfer-service`の`send_award_points`は元々`transfer_id`を引数として受け取っていた
(冪等性キーの生成に使うため)ので、それをワイヤー上のコマンド本体にも含めるだけの
小さな変更で足りた。ポイントの増減は現状すべて振込(furikomi)に起因するため、
`PointsHistoryEntry.transferId`は常に値を持つ(nullable にしていない)。

### 3. 顧客向け画面はヘッダーバッジから開く、タブとは独立した詳細画面にする

`CustomerTabBar`(「口座」「送金」の2タブ、[[0022-per-tab-navigation-state]])に3つ目の
常設タブを追加しない。ポイントは日常的な主機能ではなく副次的な情報であり、`0022`が確立した
「タブ切替は常にタブバーの仕事」という設計に新しいタブを割り込ませたくない。代わりに
`BrandAppBar`のポイントバッジ(`0025`決定2)を`<span>`から`<button>`に変え、タップで
`PointsHistoryScreen`(`DetailAppBar`+`CustomerTabBar`常設、`CustomerAccountDetail`と同じ形)
を開く。

`CustomerFlow.tsx`では`accountsTabView`/`transfersTabView`のどちらとも独立した
`pointsHistoryOpen: boolean`を持つ——開いても既存のタブのview状態を一切変更しないため、
「戻る」を押せば開いた時点の画面へそのまま戻る。タブバーの`active`ハイライトには
`activeTab`をそのまま渡す(開いた時点のタブがそのまま引き継がれる)。履歴の行から送金詳細へ
のリンクは`transfersTabView`を`detail`に設定し`activeTab`を`transfers`に切り替える——
`accountsTabView`側の`onViewTransfer`と全く同じパターン。

## トレードオフ

- **`points-service`の`TransactWriteItems`がさらに1アイテム増える**: `reserve_points`は
  4アイテム(冪等性・残高・アウトボックス・履歴)、`credit_points`は3アイテム(冪等性・残高・
  履歴)になった。DynamoDBの`TransactWriteItems`は最大100アイテムまで許容するため実務上の
  制約にはならない。
- **`AwardPoints`のワイヤー形状が変わった**(`transfer_id`追加): 後方互換性は考慮していない
  ——このPoCにデプロイ済みキューのインフライトメッセージを気にする運用は無い([[0011]]の
  `owner_id`導入時と同じ前提)。
- **ポイント履歴専用のポーリング間隔・50件上限**: `AccountHistoryTable`/
  `CustomerTransfersTable`と同じPoCスコープの割り切り(ページネーション省略)を踏襲した。

# ADR 0021: 入出金履歴と送金履歴の相互リンク

## ステータス

Accepted。`crates/query-service`の`history.rs`・`bin/query_projector.rs`、`web-ui`の
`CustomerFlow.tsx`・`CustomerAccountDetail.tsx`・`TransferDetailScreen.tsx`・
`TransactionHistory.tsx`・`api/types.ts`・`index.css`に実装する。

## コンテキスト

ユーザーから、口座メニューの入出金履歴一覧と送金メニューの送金履歴一覧の役割分担・重複、
および相互リンクの要否について検討を求められた。調査すると:

- 入出金履歴(`TransactionHistory.tsx`)は**1つの口座**の全イベント(開設/入金/出金/凍結/
  凍結解除/解約)を、金額・取引後残高とともに時系列で示す台帳そのもの。振替・振込・組戻し
  による入出金も、ATMなど外部チャネル([[0009-web-ui-customer-experience-and-channel-emulation]]決定1)による入出金も区別なく「入金」「出金」としてしか出ない。
- 送金履歴(`TransferListScreen.tsx`/`TransferDetailScreen.tsx`)は**1件の送金(サガ)**単位で、
  自分が当事者のものだけを対象に([[0017-server-side-transfer-history]])、状態(確認待ち/
  完了/取消等)・相手方名義・方向([[0020-transfer-counterparty-direction-and-name]])を示す。

`account-domain`が振込・送金という概念を一切知らない設計([[0003-domain-service-crate-boundary]]/[[0010-transfer-service-saga]])を踏まえると、この役割分担自体は妥当で意図的なものであり、
重複(振込1件が入出金履歴・送金履歴の両方に別の切り口で現れる)も統合すべき欠陥ではない。
一方で、両者を行き来する手段が全く無かった。特に、`transfer-service`が`account-service`へ
Deposit/Withdrawを発行する際に付与する`correlation_id`(=transferId、[[0010]]決定4)は
`account_events`テーブルまでは届いているのに、`query-service`の投影ロジックがこれを読み捨てて
おり、`AccountHistoryTable`にもAPIレスポンスにも一切現れていなかった——配管の途中まで来ている
データが使われずに捨てられている状態だった。

## 決定

### 1. 送金の詳細 → 自分側の口座の入出金履歴(追加のバックエンド変更なし)

`TransferDetailScreen.tsx`は既に[[0020]]で`getMyAccounts()`を使い「送金元・送金先のどちらが
自分か」を判定している。この判定をそのまま再利用し、自分の口座である側(furikaeなら両方、
furikomi/組戻しなら自分の側だけ)に「入出金履歴を見る」リンクを添える。相手方の口座には
出さない——他人の口座であり、閲覧導線を作ること自体が不適切なため。

画面遷移は`CustomerFlow.tsx`の`View`共用体に`returnTo?: View`を追加するだけで対応する。
ジャンプ元の画面を1段だけ覚えておく最小限の仕組みで、汎用のナビゲーションスタックは持たない
([[0007-web-ui-stack-and-hosting]]がルーターを避けている単純さの方針をそのまま踏襲)。

### 2. 入出金履歴の各行 → その原因になった送金の詳細(`correlation_id`をAPIまで通す)

`query-service`の`history::history_entry_from_event`に`correlation_id: Option<&str>`引数を
追加し、`bin/query_projector.rs`の`project_one`が`envelope.correlation_id`をそのまま渡す。
出力JSONに`transferId`として素通しするだけで、`AccountHistoryTable`のスキーマにもAPI
Gateway側のVTL(`GET .../transactions`)にも変更は不要だった——このエンドポイントは
`history_entry_from_event`が作った`entry`属性(JSON文字列)をそのまま配列に連結して返す
実装([[0009]])であり、Rust側でJSONの中身を1フィールド増やすだけで届く。`TransactionEntry`
型に`transferId: string | null`を追加し、`TransactionHistory.tsx`は非nullの行にだけ
「送金の詳細を見る」リンクを出す。ATM入出金等、`correlation_id`を持たない行には出ない。

### 3. リンクの見た目: `.inline-link-button`(新設、両方向で共有)

地の文に埋め込む文字サイズの下線付きテキストリンクとして新設し、通常の操作ボタン
(`button`/`button.secondary`)とは視覚的に区別する。決定1・決定2どちらのリンクも同じ
クラスを使う。

## トレードオフ

- **`correlation_id`を持たない既存の入出金行は今回の変更前から一切変わらない**:
  `transferId: null`になるだけで、表示上のリンクが出ないという後方互換な差分のみ。
- **1段だけの`returnTo`**: 口座詳細→送金詳細→(別の)口座詳細、と複数回ジャンプした場合、
  戻るボタンは直前の1画面にしか戻らない(スタックではない)。[[0007]]の単純さの方針を優先し、
  複雑なナビゲーション状態管理は導入しない——PoCの検証テーマ(イベント駆動アーキテクチャ)には
  寄与しない画面遷移の作り込みだと判断した。
- **furikaeは送金元・送金先の両方にリンクが出る**: 両方とも自分名義であるため、[[0020]]の
  名義表示とは非対称(名義は付けない)だが、リンクは両方に付ける——「この口座の残高にどう
  反映されたか確認したい」というニーズは送金元・送金先どちらの口座でも成り立つため。

## 却下した代替案

- **`AccountHistoryTable`に専用の相手方情報(名義・kind等)まで持たせる**: `transferId`だけを
  運べば、詳細は`GET /transfers/{transferId}`(既存API)を辿れば手に入る。入出金履歴側に
  送金の詳細情報を複製すると、[[0004-query-service-event-driven-projection]]以来の
  「投影は単一責務」の原則に反し、送金の状態が変わるたびに入出金履歴側も更新する必要が
  生じてしまう(入出金履歴は追記のみで更新しない設計、[[0009]])。
- **汎用のナビゲーションスタック(履歴配列)を導入する**: 今回必要なのは1段の相互リンクだけであり、
  そのために状態管理ライブラリやルーターを持ち込むのは[[0007]]の方針と合わない。

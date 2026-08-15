# ADR 0019: 送金一覧・詳細・自分の口座選択に実在の口座番号を表示する

## ステータス

Accepted。`web-ui`の`TransferListScreen.tsx`・`TransferDetailScreen.tsx`・`TransferForm.tsx`・
`hooks/useAccountNumber.ts`・`format.ts`に実装する。[[0018-transfer-destination-display-name]]
と同じユーザー報告から、そのADRが直していなかったもう一つの原因を追加で修正する。

## コンテキスト

[[0018]]で振込確認画面の「宛先名義」(Cognitoのsubがそのまま出ていた不具合)を修正し
デモデータを再作成してデプロイした後、ユーザーから改めて「送金元 ●●●●6123 / 送金先
●●●●C3F8 のように表示される」という報告を受けた。調査の結果、これは[[0018]]が直した
`TransferForm.tsx`の宛先確認ステップとは別の画面(`TransferDetailScreen.tsx`の「送金の詳細」、
`TransferListScreen.tsx`の送金一覧カード、`TransferForm.tsx`自身の「送金元の口座」/振替の
「送金先の口座」選択肢)が原因だった。

これらは`format.ts`の`formatAccountNumber(accountId)`——accountId(UUID)の末尾8桁を
16進数のまま切り出して「口座番号っぽく」見せるだけの、コメント自身が明記する通り
「表示専用の飾り」関数——を使っていた。[[0015-friendly-account-numbers-and-branch-and-other-bank-placeholder]]で支店+7桁の実在の口座番号(`account-number-projector`/`AccountNumberQueryApi`)を
導入した際、`AccountListScreen.tsx`/`AccountView.tsx`(自分の口座一覧・詳細)はこの実番号に
切り替えたが、送金まわりの3画面はこの飾り関数のまま取り残されていた。結果、`C3F8`のように
数字の口座番号にはあり得ない16進文字が混じる表示になり、口座一覧・詳細が見せる実際の口座番号
(例:「本店 613-3009」)と書式が一致しないように見えていた——ユーザーが最初に指摘した
「口座名と書式が一致しない」の実体はこちらだった。

## 決定

### 1. `formatAccountNumber`を削除し、3画面とも実在の口座番号(`AccountNumberQueryApi`)に置き換える

`AccountListScreen.tsx`/`AccountView.tsx`が既に使っている`useAccountNumber`フック
(`getAccountNumber(accountId)`、`formatFriendlyAccountNumber`)と同じ形に揃える。
`AccountNumberQueryApi`は所有者を問わず任意の`accountId`を解決できる
(Cognito認証さえあればよい、[[0015]])ため、振込の宛先(`toAccountId`)が自分以外の口座でも
同じ経路で引ける。

- `TransferDetailScreen.tsx`:「送金元」「送金先」を`useAccountNumber(fromAccountId)`/
  `useAccountNumber(toAccountId)`で解決し、`AccountListScreen.tsx`と同じ「支店名 番号」書式で
  表示する。`useAccountNumber`は`data`(送金本体)がまだロードされていない間、`accountId`に
  空文字列を渡されても発行しないよう`enabled`ガードを追加した。
- `TransferListScreen.tsx`: 各送金カードの宛先を`useQueries`で並行解決する
  (`AccountListScreen.tsx`のnumberQueriesと同じ形)。
- `TransferForm.tsx`:「送金元の口座」(振替/振込共通)・振替の「送金先の口座」選択肢も同様に
  `useQueries`で自分の口座それぞれの番号を解決する。

反映待ち(結果整合性、[[0004-query-service-event-driven-projection]])の間は
「口座番号を確認しています…」等、既存画面と同じ穏やかな文言を出す
([[eventual_consistency_not_a_failure]])。

### 2. マスク(●●●●)は導入しない——口座一覧・詳細と同じ、フルの「支店名+番号」を表示する

このアプリで唯一のマスク表現は残高の目アイコン(`MASKED_BALANCE`、`useBalanceHidden`)であり、
口座番号自体をマスクする慣習はどこにも無い(`AccountListScreen.tsx`/`AccountView.tsx`は自分の
口座番号を常にフルで表示している)。送金の相手も、振込では顧客自身が支店+口座番号を入力して
確認済みの相手であり(furikomiの宛先確認ステップ)、振替では自分自身の別口座であるため、
新しいマスク表現を発明する理由がない。既存の「口座番号は隠さず見せる」慣習にそのまま合わせる
方が、[[0018]]決定4が指摘した「アプリ内の体裁を揃える」という目的にも合致する。

## トレードオフ

- **画面あたりのAPI呼び出しが増える**: `TransferListScreen.tsx`は表示件数分の
  `GET /accounts/{id}/account-number`を並行発行する。`AccountListScreen.tsx`が既に同じパターンを
  自分の口座一覧に対して行っており、新しい設計要素ではない——このPoCの規模ではキャッシュ
  (`queryKey: ["account-number", accountId]`が既存画面と共有される)もあり許容範囲。
- **`formatAccountNumber`は完全に削除した**: 呼び出し元がゼロになったため、[[0011]]以前の
  「実在の口座番号が無かった時代の名残」を残さず削除した。将来また似た用途が要る場合は
  復活ではなく、その時点の実データから作るべき。

## 却下した代替案

- **`formatAccountNumber`が返す値の見た目だけ数字っぽく直す**: accountId(UUID)由来である限り
  実在の口座番号とは無関係な値であり続け、根本原因(実データを使っていないこと)を放置する
  対症療法になるため採らなかった。[[0017-server-side-transfer-history]]の却下代替案
  (「ブラウザで一度手動操作すれば直る」)と同じ理由で退けている。

# ADR 0025: ポイント残高の照会API・ヘッダー常設表示

## ステータス

Accepted。`infra/lib/account-pipeline-stack.ts`(`PointsQueryApi`新規)・`web-ui/src/api/`・
`web-ui/src/hooks/usePointsBalance.ts`(新規)・`web-ui/src/components/AppBar.tsx`/
`AccountListScreen.tsx`/`TransferListScreen.tsx`に決定1・2を実装。決定3・4
(送金詳細画面への`cashFee`/`pointsUsed`表示)は同セッション内でスコープを広げて追加した。
`points-service`/`fee-service`/`transfer-service`への変更は決定4のイベントペイロード拡張
(`points_used`フィールド追加)以外はない。`api-e2e`(`points-query.e2e.test.ts`・
`transfer-fee-and-points.e2e.test.ts`)がライブスタックに対してgreen(開発中に見つかった
実装漏れ・表示不具合の詳細はコミットログ・[insights.md](../insights.md)3.1を参照)。

## コンテキスト

[[0024-rewards-service-fee-and-points]]は手数料・ポイントの機能自体をバックエンドに実装したが、
顧客向けUI(手数料・ポイント残高の表示)を`[[0010-transfer-service-saga]]`決定6・
`[[0011-furikae-furikomi-distinction]]`と同じ理由で意図的にスコープ外にしていた。

しかし、この機能はそもそも「ポイントで顧客の利用モチベーションを高める」という動機から始まって
おり、ポイントが顧客から一切見えない状態では目的を果たせない。`points-service`の`PointsTable`
には照会APIが無く(`api-e2e`のテストがDynamoDBを直接読んでいたのはこのため)、顧客向けに見せる
経路がそもそも存在しなかった——このADRでその経路を新設する。

スコープは意図的に絞る: 「ポイント残高がどこからでも見える」ことに加え、`transfer-service`
自身が既に持っている現金負担分の手数料(`cash_fee`、決定3)も見せるが、**手数料の完全な内訳**
(手数料総額・ポイント充当額)の表示は次の増分に残す(`fee-service`が現在`transfer-service`に
`cash_fee`しか渡していないため(`0024`決定4)、内訳を見せるには`fee-service`自身の新しい
照会APIが要る——別途合意する)。

## 決定

### 1. `points-service`の`PointsTable`専用の新しい照会API(`PointsQueryApi`)を新設する

`[[0016-cognito-authentication]]`決定4の`GET /customers/me/accounts`と同じ設計:
`GET /customers/me/points`、Lambdaレスの`AwsIntegration`(DynamoDB`GetItem`直接統合)、
`ownerId`はリクエストパラメータではなくCognito JWTの`$context.authorizer.claims.sub`から取る
(クライアントは他人の残高を指定できない)。`[[0015-friendly-account-numbers-and-branch-and-other-bank-placeholder]]`の`AccountNumberQueryApi`と同じく、既存の`AccountQueryApi`/`TransferQueryApi`
とは別の独立した`RestApi`として新設する——`points-service`はaccount-domainにもtransfer-service
にも依存しない独立サービスであり(`0024`決定1)、その照会APIも同じ独立性を保つ。

項目が存在しない場合(一度もポイントを獲得したことがない顧客)は404ではなく`{"balance": "0"}`を
返す——`AccountNumberQueryApi`の口座番号解決とは違い、「まだ0ポイントである」ことは異常系では
なく、ヘッダーに常に何かを表示したいという決定2の要件に対して自然な既定値だから。

### 2. ポイント残高は`BrandAppBar`(口座一覧・送金一覧の共通ヘッダー)に常設する

`web-ui/src/components/AppBar.tsx`には`BrandAppBar`(全画面共通、`AccountListScreen`/
`TransferListScreen`が使う)と`DetailAppBar`(詳細画面用、戻るボタン+タイトルのみ)の2種類が
ある。ポイント残高は`BrandAppBar`にだけ追加し、`DetailAppBar`には追加しない。

理由: `DetailAppBar`は`[[0022-per-tab-navigation-state]]`が「詳細画面は1タスクに集中させる」
という設計で意図的に最小限に保っている。`BrandAppBar`は口座タブ・送金タブどちらの"ホーム"に
戻っても必ず表示されるため、「ヘッダーに常設」という一般的なポイントプログラムのUXパターンに
実質的に合致する——タブを跨いでも見える一方、個別の取引を見ている最中の画面を煩雑にしない。

`usePointsBalance()`(`useAccountNumber`と同じ形のTanStack Queryフック)を新設し、単一の
クエリキー(`["points"]`)で`AccountListScreen`/`TransferListScreen`の両方から共有する——
アカウントIDのような画面固有のパラメータを持たないため、`useAccountNumber`より単純。

### 3. 送金詳細画面に、現金負担分の手数料(`cashFee`)を表示する

`TransferSaga.cash_fee`(`0024`決定4)は`create_new_saga`の最初の書き込みから常に存在する
フィールドであり、新しい照会APIを要らない——`transfer-status-projector.rs`(`TransferSagaTable`
→`TransferStatusView`への既存の投影、`[[0012-transfer-customer-api-and-status-query]]`決定1)
が`cashFee`も転記するよう1行足すだけで、`GET /transfers/{transferId}`のレスポンスに乗る。

`TransferDetailScreen.tsx`は`cashFee`が存在する限り(`GET /transfers/{transferId}`由来なら
常に存在する、決定2のVTL参照)、`"0"`でも「手数料 ¥0」と明示的に表示する——`"0"`だから隠す
設計を最初は採ったが、実機確認で「0円だから非表示なのか、データが無いから非表示なのか
見分けがつかず、かえって不透明」という指摘を受けて撤回した。手数料という概念がシステムに
存在する以上、振替・組戻し・`cashFee`導入前の既存送金も含めて「¥0」を明示する方が透明性が
高いと判断した——`cashFee`自体が存在しない(`GET /customers/me/transfers`一覧由来を
`TransferDetailScreen`が受け取った場合等)ときだけ、行そのものを出さない。

`GET /customers/me/transfers`(一覧、`CustomerTransfersTable`)には`cashFee`を追加しない——
一覧を手数料でごちゃつかせない意図的な選択で、詳細画面だけが持てば足りる。

### 4. 送金詳細画面に、手数料の充当内訳(ポイント充当額・現金負担分・合計)を表示する

決定3で`cashFee`(現金負担分)だけを表示していたため、ポイントで手数料の一部/全部を充当した
送金では「手数料 ¥120」のように現金分しか見えず、実際に何ポイント消費したかが画面のどこにも
出ないという透明性ギャップが残っていた(`points-service`のポイント残高自体は決定1・2で見える
ようになったが、「この送金でいくら使ったか」は依然として不可視)。決定3が解消した
「0円だから非表示なのか判別できない」問題と同じ種類の不透明さがポイント充当について再発して
いたため、決定3と同じ方針(存在する限り0でも隠さない)をポイント充当にも適用する。

`fee-service`の`FeeReservation.points_used`(`0024`)は`FeeReservationsTable`にしか存在せず、
`fee.event.FeeReserved`イベントのペイロードは`cash_portion`のみを運んでいた
(`fee-service/src/persistence.rs`の`advance_to_reserved`)。このペイロードに`points_used`を
追加し、`cash_fee`が既にたどっている経路(`saga_step.rs`の`reserve_fee_observed`→
`TransferSaga.points_used`(新規フィールド)→`persistence.rs`のDynamoDB項目変換→
`transfer_status_projector.rs`→`TransferStatusView`→`GET /transfers/{transferId}`のVTL)に
そのまま相乗りさせる——`cashFee`と全く同じ形で1フィールド追加しただけで、新しいAPI/テーブル/
Lambdaは一切増やしていない。

手数料の合計額(`fee_amount`)自体はtransfer-serviceに複製しない——常に
`cash_fee + points_used`が成り立つため(`points_reserved`で`cash_portion = fee_amount -
points_used`と計算している、`fee-service/src/reservation.rs`)、`web-ui`側で導出する。
これにより「`fee-service`が手数料額を所有する」という`0024`決定2の境界を崩さずに済む。

`TransferDetailScreen.tsx`は「手数料(合計)」「うちポイント充当」「うち現金でのお支払い」の
3行を、`cashFee`と`pointsUsed`の両方が存在する場合にのみ表示する(決定3と同じく、
`GET /customers/me/transfers`一覧由来のデータではどちらも存在しないため何も出さない)。
0でも隠さない(決定3の方針を継承)。

`api-e2e/scenarios/transfer-fee-and-points.e2e.test.ts`の既存シナリオ(ポイント充当あり/なし)
に、`GET /transfers/{transferId}`の`pointsUsed`フィールドが期待通りの値を返すことの確認を
追加し、実デプロイ済みスタックに対して検証済み(2026-08-19)。

## トレードオフ

- **`BrandAppBar`にポイント残高バッジが実際に描画されるかは、`ui-e2e`(ブラウザ)では未検証**:
  バックエンドのAPI契約(`points-query.e2e.test.ts`)と`web-ui`の単体テスト(vitest、モック経由)
  はどちらもgreenだが、実ブラウザでの描画確認は次の機会に残している。
- **`DetailAppBar`にはポイント残高が出ない**: 送金詳細・口座詳細を見ている間はヘッダーから
  ポイント残高が消える。「常に」表示を厳密に守るなら妥協だが、`0022`のミニマルな詳細画面設計を
  崩さない方を優先した。
- **新しいDynamoDB項目が存在しない場合の`{"balance": "0"}`という既定値表現**: `points-service`
  側では「項目が存在しない」ことと「残高0」は区別されない(`ledger::reserve`/`credit`も同様に
  存在しない項目を残高0として扱う、`0024`)ため、この照会APIでも同じ扱いに揃えているだけで
  新しい非対称を持ち込むものではない。

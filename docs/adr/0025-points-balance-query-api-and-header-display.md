# ADR 0025: ポイント残高の照会API・ヘッダー常設表示

## ステータス

Accepted。`infra/lib/account-pipeline-stack.ts`(`PointsQueryApi`新規、CloudFrontプレフィックス
`/points-query-api`追加)・`web-ui/src/api/`・`web-ui/src/hooks/usePointsBalance.ts`(新規)・
`web-ui/src/components/AppBar.tsx`/`AccountListScreen.tsx`/`TransferListScreen.tsx`。
`points-service`/`fee-service`/`transfer-service`への変更は無い(純粋に読み取り経路の追加)。

デプロイ後、`api-e2e`の新規`scenarios/points-query.e2e.test.ts`で以下を実デプロイ済みスタックに
対して検証済み(2026-08-18): 未獲得の顧客に`{"balance": "0"}`が返る・未認証リクエストが401に
なる・振込でポイントが付与された後は`GET /customers/me/points`でも同じ値が見える。検証中、
`amount * award_rate`(`saga.rs`の`award_points_for`)がscaleを持ち越して`"0.300"`のような
文字列になりうることに気づき(`rust_decimal`の乗算はscaleを自動的に正規化しない)、
テストの期待値を文字列の完全一致ではなく数値比較に直した——CLAUDE.mdの「AWS/ライブラリの
挙動は仮定せず確認する」を踏まえ、憶測で`"0.3"`と決め打ちしなかった。

**未検証のまま残るもの**: `web-ui`の単体テスト(vitest、モック経由)は全てgreenだが、
実際のブラウザで`BrandAppBar`にポイント残高バッジが正しく描画されるかは`ui-e2e`
(Playwright)による確認をまだ行っていない——バックエンドのAPI契約は検証済みだが、
見た目の検証は次の機会に残す。

**追記(同日)**: 最初のデプロイ後、ユーザーから「手数料が見えない」という指摘を受けて確認した
ところ、決定3で述べる`cashFee`の投影・表示が実装から漏れていたことが判明した(コンテキストで
「`transfer-status-projector.rs`が持っている`cash_fee`を送金詳細画面に出せる」と自分で書いて
おきながら、実際にはポイント残高の話だけを実装して終えていた)。デモデータの問題ではなく
実装漏れだったため、同じセッション内で決定3として追加・実装し、`api-e2e`の
`scenarios/transfer-fee-and-points.e2e.test.ts`にAPI経由での確認を追加して再デプロイ・
再検証した。

**追記2(同日)**: 決定3のデプロイ後、ユーザーから「手数料が¥のみ(数字が付かない)と表示される」
という指摘を再度受けた。原因は二重で、①ご覧になった送金が`cashFee`導入(0024/0025)より前に
作られた既存データだったため、DynamoDBの当該アイテムに`cashFee`属性自体が存在しなかった
(スキーマレスなDynamoDBへ後から必須属性を足しても既存アイテムには反映されない——`0011`の
`owner_id`導入時と同じ既知の現象)、②それに加えて自分のVTL側の不備で、属性が存在しない場合に
`$input.path(...)`が返す空文字列をそのまま`"cashFee":""`としてしまい、
`formatCurrency("")`が「¥」だけの壊れた表示になっていた。②を`#if`による`"0"`への
フォールバックとして修正し(振替・組戻しと同じ「手数料なし」表示に収束する)、実際に壊れて
見えていた送金IDに対して修正後のAPIレスポンスが`"cashFee":"0"`になることを直接確認した。

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

`TransferDetailScreen.tsx`は`cashFee`が存在し、かつ`"0"`でない場合(=実際に現金負担が
発生した振込)だけ「手数料」の行を表示する。振替・組戻しは常に`"0"`のため何も出ない。
`GET /customers/me/transfers`(一覧、`CustomerTransfersTable`)には`cashFee`を追加しない——
一覧を手数料でごちゃつかせない意図的な選択で、詳細画面だけが持てば足りる。

## トレードオフ

- **手数料の完全な内訳(手数料総額・ポイント充当額)はこのADRでは見せない**: 決定3は現金負担分
  (`cashFee`)だけを見せる——「手数料はいくらだったか」までは分かるが、「いくらポイントで
  賄ったか」は`fee-service`自身の照会API(次の増分)が無いと見えないまま。
- **`DetailAppBar`にはポイント残高が出ない**: 送金詳細・口座詳細を見ている間はヘッダーから
  ポイント残高が消える。「常に」表示を厳密に守るなら妥協だが、`0022`のミニマルな詳細画面設計を
  崩さない方を優先した。
- **新しいDynamoDB項目が存在しない場合の`{"balance": "0"}`という既定値表現**: `points-service`
  側では「項目が存在しない」ことと「残高0」は区別されない(`ledger::reserve`/`credit`も同様に
  存在しない項目を残高0として扱う、`0024`)ため、この照会APIでも同じ扱いに揃えているだけで
  新しい非対称を持ち込むものではない。

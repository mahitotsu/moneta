# ADR 0027: item単位の読み取り認可

## ステータス

Accepted。`crates/query-service`(`src/bin/query_projector.rs`)・`crates/transfer-service`
(`src/bin/transfer_status_projector.rs`)・`infra/lib/account-pipeline-stack.ts`
(`CustomerAccountsTable`の`byAccountId` GSI、`GetAccountIntegration`・
`listTransactionsIntegration`・`getTransferIntegration`の3つのVTL)・
`infra/scripts/backfill-item-owners.ts`(新規)に実装する。

`cargo test`/`cargo clippy`(全crate、警告0件)、`infra`のCDK synth(48件)、`api-e2e`
(新規`item-level-authorization.e2e.test.ts`を含む28スイート62テスト)がライブスタックに対して
green。デプロイ後の`backfill-item-owners.ts`実行と、実機検証で見つかった2件の発見(既存の
複数識別子シナリオがこのADRの塞いだ抜け穴に依存していたこと——[insights.md](../insights.md)
2.2、L1のプロパティベーステストが追加レイテンシでタイムアウトに触れたこと)の詳細はコミット
ログを参照。

## コンテキスト

[[0016-cognito-authentication]]は、認証済みの別人が他人の`accountId`を直接URLに指定すれば
`GET /accounts/{id}`を閲覧できてしまうギャップ(「認証」は満たすが「この口座は自分のものか」
という認可は満たさない読み取り系の非対称)を、意図的に見送ったトレードオフとして記録していた
——「item単位の認可をVTLで表現しづらく、実装するにはLambda経由に変える必要がある。それは
このPoCが検証している『Lambdaレス直接統合』という設計そのものを手放すことになる」という理由。
同じ非対称は`GET /transfers/{transferId}`(`TransferQueryApi`)にもあり、2026-08-18に
[[0025-points-balance-query-api-and-header-display]]の動作確認中、無関係な使い捨て識別子から
実際に他人の送金を閲覧できることを直接確認していた。

バンキングアプリである以上セキュリティは最優先で扱うべき、というユーザーの明示的な指示を
受けてこのギャップに着手した。改めて調査した結果、**Lambdaを増やさずにVTLだけで実装できる**
ことが分かった——ADR-0016時点の判断は覆る。GetItem/Queryの**レスポンス**側VTLで
`$context.authorizer.claims.sub`とアイテム自身が持つ名義属性を比較するだけで済む。
`account-domain`・`account-service`のドメインロジックには一切手を入れない。

## 決定

### 1. 口座照会(`GET /accounts/{accountId}`・`GET /accounts/{accountId}/transactions`)

`AccountViewTable`・`AccountHistoryTable`の各アイテムに`ownerId`をトップレベル属性として
持たせる。ソースは`query-service`が既に書き込んでいる`CustomerAccountsTable`(PK `ownerId`、
SK `accountId`、[[0016]]決定4)——これに`accountId`をPKとする新GSI `byAccountId`を追加する
(`AccountNumbersTable`が既に持つ同名GSI、[[0015-friendly-account-numbers-and-branch-and-other-bank-placeholder]]と同じ「基本キーとは別目的の索引を足す」パターン)。

`query_projector.rs`の`project_one`は、イベントが`Event::Opened { owner_id, .. }`ならその値を
そのまま使う(ルックアップ不要、レースが起きない)。それ以外のイベントは上記GSIへの`Query`で
`ownerId`を解決する——まだ反映されていなければエラーとしてbatch item failureで報告し、Lambdaの
再試行に委ねる([[eventual_consistency_not_a_failure]]、`transfer-service::persistence::load_owner`
の呼び出し元と同じ扱い)。`query-service`は`account-service`の内部(`accounts`テーブル等)を
一切読まない——query-serviceが既に所有する`CustomerAccountsTable`を読むだけなので、
[[0008-query-service-crate-extraction]]のcrate境界(query-serviceは書き込み経路の内部に踏み込まない)
を破らない。

API Gateway側は、`GetAccountIntegration`のレスポンスVTLに404判定と同じ`responseOverride.status`
の手法で403判定を追加する(`Item.ownerId.S != $context.authorizer.claims.sub`)。
`listTransactionsIntegration`(Query統合)はリクエストVTLに`FilterExpression: "ownerId = :ownerId"`
を追加し、フィルタ後0件なら403にする——`Event::Opened`は必ず履歴1件を生む
(`crates/query-service/src/history.rs`)ため、実在する口座なら空配列は「他人の口座」の
シグナル以外にありえず、404/403の判定に曖昧さは生じない。`Limit`(50)はDynamoDB内部で
`FilterExpression`適用前のキー一致件数に対してかかる(AWS公式ドキュメントで確認済みの既知の
挙動)が、同一`accountId`(パーティション)配下のアイテムは全て同じ`ownerId`を持つため、
この境界ケースは実害がない——「一部だけ絞り込まれて消える」ことが起こり得ない(全件一致か
全件不一致かの二択)。

### 2. 送金照会(`GET /transfers/{transferId}`)

`TransferSagaTable`のアイテムは`saga_to_item`(`crates/transfer-service/src/persistence.rs`)
により、サガ作成時から既に`fromOwnerId`/`toOwnerId`を持っている——新しいルックアップは不要。
`transfer_status_projector.rs`の`SagaImage`にこの2属性を追加し、`TransferStatusViewTable`への
`PutItem`にそのまま転記するだけでよい。

`getTransferIntegration`のレスポンスVTLは、404判定の後に`fromOwnerId`と`toOwnerId`の
どちらとも一致しなければ403にする(振込は送金元・送金先で名義が異なるため「いずれか一致」
——[[0020-transfer-counterparty-direction-and-name]]が既に確立した「送金元/送金先どちらから見ても
自分の送金として見える」という前提と対称)。

### 3. スコープ外にするもの

- `AccountNumberQueryApi`(口座番号→口座解決): [[0019]]が明記する通り「呼び出し元の所有権に
  関わらず誰の`accountId`でも解決する」設計を意図的に維持している(振込先の名義確認という
  別の正当な用途——本人確認の代わりに、実在の銀行が「宛先の名義を確認させてから確定させる」の
  と同じ機能)。今回のギャップとは別物であり、変更しない。
- `GET /customers/me/*`系(accounts/transfers/points/points/history): `ownerId`をJWTの`sub`
  から取得しクライアント入力を受け付けないため、構造的にこの種の漏洩が起きない
  ([[0016]]のトレードオフ節が既に明記)。

### 4. 既存デプロイ済みデータのバックフィル

新規イベントでのみ`ownerId`/`fromOwnerId`/`toOwnerId`が埋まるため、デプロイ時点で既に存在する
アイテムは新しいイベントが発生するまで属性を持たない。認可は「属性が無ければ拒否」という
安全側の既定であるべき([[0025]]の「無ければ0にフォールバック」とは逆——認可における安全側の
デフォルトは「拒否」)なので、そのまま放置すると既存のdemoデータ・稼働中の口座/送金が
軒並み403になってしまう。

`infra/scripts/backfill-item-owners.ts`(新規、`npm run backfill-item-owners`)を追加した。
`accounts`テーブル(account-serviceの内部テーブル)・`TransferSagaTable`
(transfer-serviceの内部テーブル)を直接読み、`AccountViewTable`/`AccountHistoryTable`/
`TransferStatusViewTable`の該当アイテムへ属性を補完する。このスクリプトはどのサービスの
Lambdaコードパスでもない独立した運用ツールであり、`clean-data.ts`が既に複数サービスの
テーブルを横断しているのと同じ扱い——crate境界(決定1)の対象外。冪等(既に属性を持つ
アイテムはスキップ)。デプロイ後、一度だけ実行する。

## トレードオフ

- **口座開設直後の狭いeventual consistencyの窓では、一瞬だけ正当な所有者にも403が返り得る**:
  `Opened`以外のイベントの`ownerId`解決は`CustomerAccountsTable`への反映を前提とする——通常は
  同一口座内で`Opened`が必ず先に処理されるため実害はほぼ無いが、理論上は同時に発生した2つの
  独立したLambda([[0016]]決定4の`customer-accounts-projector`と本ADRのquery projector)の
  競争条件にはなる。既存のバッチ項目失敗による再試行で自然に解消するため、
  [[eventual_consistency_not_a_failure]]の延長として許容する。
- **取引履歴のフィルタ後0件は404ではなく403として返る**: 口座そのものが存在しない場合と
  「他人の口座」の場合を区別しない(決定1)。この経路は`GET /accounts/{id}`の404を先に
  経由しない直接呼び出しでしか到達しないため、正当な利用フロー(web-uiは常に口座詳細を先に
  取得する)には影響しない。
- **新しいLambda・テーブルは増やさない**が、`query_projector.rs`はイベント1件あたり
  最大1回の追加`Query`呼び出しを持つ(`Opened`以外)。個々のリクエストのコスト・レイテンシは
  無視できるが、**実機検証で判明した実害が1件ある**: `api-e2e/scenarios/conservation-property.e2e.test.ts`
  (L1、多数の振替を連続実行するプロパティベーステスト)が、この追加レイテンシの積み重ねにより
  元の600秒ちょうどのJestタイムアウトで実際にタイムアウトした(2026-08-20、デプロイ後の
  `npm test`実行)——資金保存則そのものは破られておらず(タイムアウト後に再実行すると
  102秒で合格)、結果整合性の反映待ちが間に合わなかっただけと判明。テストのタイムアウトを
  900秒に拡大して解消した。CLAUDE.mdの「AWS/ライブラリ挙動は実機で確認する」を地で行く
  発見で、「無視できる」という当初の見立てはマイクロベンチマークとしては正しいが、
  多数の操作を連続実行するテストのような累積的な影響は実際にデプロイして初めて可視化された。

## 却下した代替案

- **クエリ系エンドポイントをLambda経由に変える**([[0016]]が当初検討し見送った案そのもの):
  今回VTLだけで実現できたため不要と判明した。「Lambdaレス直接統合」というこのPoCが検証している
  設計を手放さずに済む。
- **AccountViewTable/TransferStatusViewTableを`(ownerId, accountId)`複合キーに変える**:
  クライアントはaccountId/transferIdしか知らず、ownerIdをキーの一部にするとクライアントが
  検索キーを組み立てられなくなる(認可情報を検索条件に混ぜてしまう設計はそもそも成立しない)。

# ADR 0017: 送金履歴のサーバー側投影化

## ステータス

Accepted。`crates/transfer-service`の`transfer-history-projector`(新規)、
`infra/lib/account-pipeline-stack.ts`の`CustomerTransfersTable`・
`GET /customers/me/transfers`、`web-ui`の`api/client.ts`・`TransferListScreen.tsx`・
`TransferDetailScreen.tsx`に実装する。[[0012-transfer-customer-api-and-status-query]]決定6
「顧客が開始した送金の一覧はweb-ui localStorageのみで表現する」を、同決定6自身が明記していた
再検討条件(「口座の入出金履歴と統合した一覧表示が必要になった時点で再検討する」)に基づいて
覆す。

## コンテキスト

[[0016-cognito-authentication]]でデモ用の永続データ(`infra/scripts/seed-demo-data.ts`)を
用意した際、Transfer Command APIを直接HTTPで叩いて振替・振込を作成した。バックエンド
(`TransferSagaTable`・`TransferStatusView`)は正しく`credited`まで完了したが、Web UIの
「送金」タブには一切表示されなかった——[[0012]]決定6の設計通り、送金履歴は顧客のブラウザの
localStorageにしか保存されず、しかも書き込まれるのは`TransferForm`から実際にそのブラウザで
送金を開始した瞬間だけだったため、どのブラウザにも一度も書き込まれていなかった。

この状況に「そのブラウザで一度手動操作すれば直る」という対症療法を提案したところ、
「実用的なアプリをイベント駆動で作れるかどうかを検証するのが目的なのだから、サーバー側の
投影で解決すべきではないか」という指摘を受けた。[[0012]]決定6が却下した代替案
(`TransferSagaTable`へのGSI追加によるサーバー側一覧)は、当時「このPoCで検証したい論点
(振替/振込のサーバー側判定、確認フロー、組戻し)には寄与しない」という理由で優先度を
上げなかったものだが、[[0016]]決定4の`CustomerAccountsTable`(口座一覧のサーバー側投影化)
以降、口座一覧は既にサーバー側投影に切り替わっており、送金一覧だけがlocalStorage方式のまま
残っていた非対称は、まさにその再検討条件(「口座の入出金履歴と統合した一覧表示が必要になった
時点」)に該当する。

## 決定

### 1. `TransferSagaTable`へのGSI追加ではなく、`transfer-status-projector`と同型の専用の小さな投影を新設する

[[0012]]決定1が却下した「`TransferSagaTable`へのGSI追加」は今回も採用しない——GSIは
`fromAccountId`単位でしか引けず、「振込を受け取った側(`toAccountId`)の一覧にも出す」という
今回追加したい要件(下記決定2)を満たすには、結局`fromAccountId`用・`toAccountId`用の
2つのGSIか、書き込み時に正規化した別テーブルが要る。後者の方が[[0011-furikae-furikomi-distinction]]の`transfer-owner-projector`・[[0016]]の`customer-accounts-projector`と
一貫した「イベント駆動の専用小テーブル」パターンにそのまま乗るため、これを選ぶ。

`transfer-history-projector`(新規、`crates/transfer-service/src/bin/`)は
`transfer-status-projector`と全く同じ`TransferSagaTable`のDynamoDB Streams(NEW_IMAGE)を
購読する——同一テーブルに対する複数のLambdaトリガーはDynamoDB Streamsの標準的な使い方であり、
新しい設計要素ではない。

### 2. 送金元・送金先の両方のownerIdへ書く(`CustomerTransfersTable`、PK `ownerId`、SK `transferId`)

`transfer-history-projector`は`fromAccountId`・`toAccountId`それぞれの名義を
`TransferAccountOwnersTable`([[0011]]、`persistence::load_owner`)から解決し、
両方のownerId分だけ`CustomerTransfersTable`へ`PutItem`する。振替(同一名義)は結果的に1件
(自分自身)に収束し、振込(名義不一致)は送金元・送金先それぞれの「送金」タブに現れる
——実際の銀行が振込を受け取った側にも入出金明細として見せるのと同じ体験。名義がまだ
`TransferAccountOwnersTable`に反映されていない場合は`transfer-status-projector`と同じく
バッチ項目失敗として報告し、Lambdaの再試行に委ねる(結果整合性、
[[eventual_consistency_not_a_failure]])。

**範囲キーは`updatedAt#transferId`ではなく`transferId`単体**(実デプロイ後の動作確認で
発覚した設計修正——下記トレードオフ節参照)。同一`transferId`の複数回の状態遷移(
`pending_confirmation`→`pending_debit`→`pending_credit`→`credited`等)が常に同じアイテムへ
収束し、`transfer-status-projector`が`TransferStatusView`をtransferId単位で収束させているのと
対称になる。

### 3. `GET /customers/me/transfers`を`TransferQueryApi`に追加する(`byUpdatedAt` GSI経由)

[[0016]]決定4の`GET /customers/me/accounts`と同じLambdaレスDynamoDB `Query`直接統合。
`ownerId`はリクエストパラメータではなく`$context.authorizer.claims.sub`から取る
(クライアントは他人のownerIdを指定できない)。「新しい順」はベーステーブル自体のSKでは
表現できない(決定2の通りSKは`transferId`固定のため)ので、`byUpdatedAt` GSI(PK `ownerId`、
SK `updatedAt`、ALL射影)を新設し、`ScanIndexForward: false`でそちらをQueryする——
[[0015-friendly-account-numbers-and-branch-and-other-bank-placeholder]]の`AccountNumbersTable`
が逆引き用に`byAccountId` GSIを持つのと同じ「基本のキーとは別目的の索引を足す」設計。

### 4. Web UI: `transferHistory.ts`(localStorage)を削除し、`TransferListScreen.tsx`は
このAPIをReact Queryでポーリングする

[[0016]]決定4が`AccountListScreen.tsx`の`getAccountsFor`(localStorage)を`getMyAccounts()`
(サーバー)に置き換えたのと同じ形。送金を開始した直後に`addTransferFor`でローカルへ即時反映
していた処理は不要になる——口座開設時と同様、一覧は`refetchInterval`ポーリングが
`transfer-history-projector`の反映を自然に拾う。`TransferDetailScreen.tsx`の組戻しフローも
同様に`addTransferFor`呼び出しを削除し、`customerName` propは(この用途以外に使っていな
かったため)両コンポーネントから削除する。

## トレードオフ

- **書き込みから一覧への反映までに近リアルタイムだが非ゼロの遅延が生じる**——
  `transfer-status-projector`と同じDynamoDB Streams経由であり、新しい種類のトレードオフでは
  なく[[0012]]決定1が既に受け入れているものの延長。
- **新しいLambda+DynamoDBテーブルが1組増える**——[[0012]]決定1の`transfer-status-projector`・
  `TransferStatusView`と全く同じ形の既存パターンの再利用であり、新しい設計要素を持ち込む
  わけではない。
- **[[0012]]決定6が明記していた「複数端末間の同期はそもそも想定していない」制約は、この決定で
  解消される**(サーバー側投影になったため)——[[0016]]決定4が口座一覧について既に達成した
  ことと対称。
- **範囲キー設計は初回実装では誤っていた(実デプロイでの動作確認により発覚)**: 当初、範囲キーを
  `updatedAt#transferId`にしていた。DynamoDBの条件なし`PutItem`は「同じキーへの上書き」で
  収束するはずだったが、`updatedAt`はサガが状態遷移するたびに変わるため、キー自体が毎回変わり
  ——「上書き」ではなく「新しいアイテムの追加」になってしまっていた。デプロイ後、デモ用の
  1件の振込(4回の状態遷移)が一覧に4行、1件の振替(3回の状態遷移)が3行、それぞれ重複して
  現れているのを`GET /customers/me/transfers`への実際の呼び出しで発見し、決定2・3の形
  (範囲キーを`transferId`固定にし、並び替えは別GSIへ分離)に修正した。ADR執筆時点の設計と
  実装後に判明した設計が食い違った、この一連の作業内で最も具体的な「実際にデプロイして
  確かめる」ことの価値を示す事例。

## 却下した代替案

- **`TransferSagaTable`への`fromAccountId`/`toAccountId`の2本のGSI**: 決定1の通り、
  正規化された専用テーブルの方が既存パターンと一貫しており、振込の受取側にも見せるという
  要件を素直に満たせる。
- **ブラウザで一度手動操作すれば直る、という運用でのしのぎ**: 実際に検討したが却下した。
  このPoCの検証テーマ(実用的なアプリをイベント駆動で作り切れるか)そのものに反する
  対症療法であり、根本原因(サーバー側投影が無い)を放置するだけだった。

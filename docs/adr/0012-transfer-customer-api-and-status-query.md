# ADR 0012: Transfer serviceの顧客向けAPI Gateway(送金受付・状態照会)とWeb UI統合

## ステータス

決定1〜5(送金状態照会API・送金受付API)はAccepted、実装・実デプロイ・E2E検証済み
(`e2e/`、20スイート35テスト)。決定6(Web UI)はAccepted、実装済み(`web-ui/src/`の
`TransferListScreen.tsx`・`TransferDetailScreen.tsx`・`TransferForm.tsx`・
`CustomerTabBar.tsx`・`transferHistory.ts`他)。`cd web-ui && npm run build && npm run lint
&& npm test`は green。実デプロイ環境上でのJ1・J5〜J10のハッピーパス手動確認はまだ未実施
(次のステップに残す)。

## コンテキスト

[[0010-transfer-service-saga]]・[[0011-furikae-furikomi-distinction]]によりTransfer service
のサガ本体(`transfer-command-intake`/`transfer-saga-step`/`transfer-owner-projector`)は
実装済みで、E2Eシナリオ J1〜J10([docs/e2e-scenarios.md](../e2e-scenarios.md))で挙動が
自動検証されている。一方で顧客向けの入口は存在しない:

- 送金の受付経路はTransfer受付キュー(`moneta-transfer-commands-main.fifo`)への直接
  `SendMessage`のみで、API Gatewayがない([[0010-transfer-service-saga]]決定6)。
- **照会APIはサガ状態を一切公開していない**。E2Eテストは`support/sagaState.ts`で
  `TransferSagaTable`をDynamoDBから直接ポーリングする裏口を使っている
  (docs/e2e-scenarios.md 246-251行目)。顧客向けのUIを作る以上、この裏口に相当する経路を
  正式なAPIとして用意する必要がある。

バックエンドが実機E2Eで検証済みの状態でこの増分に入れるため、[[0004-query-service-event-driven-projection]]や[[0006-write-path-api-gateway-sqs-direct-integration]]の初回実装時のような
未知のAWS挙動に起因するリスクは相対的に小さい。既存の確立済みパターン(Lambdaレス直接統合)を
そのまま踏襲することを基本方針とする。

## 決定

### 1. 照会経路: DynamoDB Streams駆動の専用ビュー(`TransferStatusView`)を新設し、API Gatewayはそちらにのみ直接統合する

```
TransferSagaTable(書き込み専用、CAS)
  └─ DynamoDB Streams(NEW_IMAGE)
       └─ transfer-status-projector Lambda(明示的なフィールド写像)
            └─ TransferStatusView(読み取り専用) ← API Gateway GetItem直接統合
```

これは新しい発明ではなく、`transfer-service`が[[0011-furikae-furikomi-distinction]]で
既に導入している`transfer-owner-projector`(EventBridgeで観測した`account.event.Opened`を
`TransferAccountOwnersTable`という別のDynamoDBへ投影する、まさに同じ形のコンポーネント)を、
トリガーをEventBridgeからDynamoDB Streamsに変えて踏襲するだけである。`query-service`にも
`transfer-service`にも新しいcrate間依存を持ち込まない(`transfer-status-projector`は
`transfer-service`自身の新しいbinaryとして、`owner_projector.rs`の隣に置く)。

AWS公式ドキュメントで確認したところ、DynamoDB Streams自体には稼働の有無によらない時間課金は
存在せず、Lambdaトリガー経由の`GetRecords`呼び出しは無料である(通常のStreams読み取り課金は
Lambda以外の直接呼び出しにのみ発生する)。「稼働していないときは課金されない」という本PoCの
コスト方針と合致する。

**却下した代替案: `TransferSagaTable`そのものへAPI Gateway→DynamoDB `GetItem`直接統合する
(専用ビューを作らない)。** [[0004-query-service-event-driven-projection]]決定3・4が
確立した設計原則は、「読み取り側が本来欲しい形(view)を起点に、書き込み側のスキーマとは
独立に導出する」ことである(決定3「サービス境界とOwnershipは『Viewスキーマへのwill』を
起点に決める」)。`TransferSagaTable`を直接晒す案は、この「will」を経ずに「たまたま今の
オペレーション用の形が顧客向けにも使えそうだから流用する」という順序の逆転であり、
本プロジェクトが他の箇所で一貫して守ってきたCQRS的な書き込み/読み取りの分離を、
Transferだけ緩めることになるため不採用とする。

- **オペレーション用ストアと顧客向け契約のライフサイクルが本来別物である**。
  `TransferSagaTable`はサガのCAS制御(`persistence.rs`の`create_new_saga`/
  `advance_saga_state`)のためだけに存在し、その保持期間はオーケストレーションの正しさに
  必要な期間で決まるべきものである。一方、顧客が過去の送金状況を参照できるべき期間はそれとは
  独立した業務要件であり、両者を同じテーブルに結びつけると、将来どちらかの都合(例:
  サガ完了後のTTL削除、あるいはリトライカウンタ等の内部フィールド追加)が意図せずもう一方に
  波及する。
- **書き込み側と読み取り側のIAM境界が滲む**。API Gatewayに`TransferSagaTable`への
  `dynamodb:GetItem`を許可すると、`transfer-command-intake`/`transfer-saga-step`が
  読み書きする運用テーブルに、顧客向け読み取り経路という別の主体からの直接アクセス経路が
  増える。

さらにAWS公式ドキュメントで確認した通り、DynamoDB Streamsは**同一アイテム(同一パーティション
キー)に対する変更については、実際の変更順序と同じ順序でストリームレコードが並ぶことを保証する**
(Lambdaのevent source mappingも既定の`ParallelizationFactor`ではこの順序を保ったままシャードを
処理する)。[[0004-query-service-event-driven-projection]]決定5がEventBridgeアウトボックスの
at-least-once・順序無保証を前提にlast-writer-wins(`ConditionExpression`による`lastEventAt`
比較)を要したのに対し、こちらは同一`transferId`内の順序が最初から保証されるため、
`transfer-status-projector`は条件なしの`PutItem`で足りる(同じレコードが再配信されても、
最新の状態を上書きするだけで収束する)。これはコピーした結果ではなく、DynamoDB Streamsという
異なるソースの性質から導かれる、単純だが正当な差分である。

`transfer-status-projector`は`TransferSagaTable`のNEW_IMAGEを丸ごと転記するのではなく、
`transferId`/`fromAccountId`/`toAccountId`/`amount`/`kind`/`state`/`updatedAt`だけを
明示的に写像する(`saga_to_item`/`item_to_saga`と同じ「変換はここだけに置く」流儀)。これにより
将来`TransferSagaTable`に内部専用フィールド(リトライカウンタ等)が増えても、投影コードを
変更しない限り顧客向け契約には現れない——[[0004-query-service-event-driven-projection]]決定4
「Viewはevent自身の情報だけから導出する」の精神をここでも守る。

`GetItem`が空の場合は404へ変換する(決定6と同じVTLパターン)。

### 2. 送金受付API Gateway: [[0006-write-path-api-gateway-sqs-direct-integration]]と同じLambdaレスVTLパターンを踏襲する

account-serviceのコマンドAPIと同じ理由(読み取り経路との対称性、書き込み経路にLambdaの
コールドスタートを追加しない)で、`transfer-commands-main.fifo`への`SendMessage`を
API Gatewayから直接統合する。[[0006-write-path-api-gateway-sqs-direct-integration]]決定1が
実機検証で発見した3つの不具合(二重引用符のエスケープ、`#set`行の改行混入、
`selectionPattern`未指定によるステータスコードの誤変換)への対処はそのまま再利用できるはずだが、
**「はず」で終わらせず、デプロイ後に`aws apigateway test-invoke-method`で再検証する**
(CLAUDE.mdの「AWS/ライブラリの挙動は推測せず検証する」方針、[[verify_aws_specs_before_implementing]])。
VTLテンプレート自体は使い回せないため2枚目を書くことにはなるが、パターンが未知ではない分リスクは
[[0006-write-path-api-gateway-sqs-direct-integration]]着手時より低いと判断する。

**却下した代替案: 簡易な検証用Lambdaを前段に挟む。** [[0006-write-path-api-gateway-sqs-direct-integration]]決定1と同じ理由(Lambdaレス対称性を崩す/新たなコールドスタート経路を増やすコストに
見合わない)で不採用。

### 3. `Idempotency-Key`ヘッダーは要求しない。`MessageDeduplicationId`はVTL側で`{transferId}-{アクション}`から導出する

[[0006-write-path-api-gateway-sqs-direct-integration]]決定3はVTLにハッシュ化・UUID生成の
手段がないことを理由にクライアント生成のヘッダーを必須にしたが、Transferのコマンドは
account-serviceのDeposit/Withdrawと異なり**リソースパスとアクションが1対1で固定**であり
(`PUT /transfers/{transferId}`は常に`Start`、`POST /transfers/{transferId}/confirm`は常に
`Confirm`)、`transfer_id`自体が既にクライアント生成の一意な識別子である。したがって
`{transferId}-start`のような固定サフィックス付き文字列をVTLの単純な変数展開
(`#set($dedupId = "${transferId}-start")`、ハッシュ化ではなく文字列結合のみ)で導出でき、
同一リクエストの再送は自動的に同じ`MessageDeduplicationId`になり冪等性が保たれる。これは
`transfer-service`自身が内部でaccount-serviceへコマンドを発行する際に使っている規約
(`crates/transfer-service/src/commands.rs`の`format!("{correlation_id}-withdraw")`)と
同じ考え方を、顧客向けAPIの層にもそのまま適用したものである。ヘッダーを1つ減らせる分、
Request Validatorも単純になる。

### 4. RESTリソース構成: コマンドごとに個別のリソースに分ける

[[0006-write-path-api-gateway-sqs-direct-integration]]決定4と同じ理由(1つの多態的
エンドポイントだとRequest ValidatorのモデルがJSON Schema Draft-4と相性の悪い`oneOf`に
なる)で、コマンドごとにリソースを分ける。

| Method | Path | コマンド | Body |
|---|---|---|---|
| PUT | `/transfers/{transferId}` | `Start` | `from_account_id`, `to_account_id`, `amount` |
| POST | `/transfers/{transferId}/confirm` | `Confirm` | (なし) |
| POST | `/transfers/{transferId}/cancel` | `Cancel` | (なし) |
| PUT | `/transfers/{transferId}/recall` | `Recall` | `original_transfer_id` |
| GET | `/transfers/{transferId}` | (照会、決定1) | — |

`transferId`はクライアント生成([[0006-write-path-api-gateway-sqs-direct-integration]]決定2と
同じ理由: `TransferCommand::Start`がバックエンド採番の経路を持たない)。`Recall`のパスにも
新しい`transferId`(組戻し自身のサガID)を置き、取消対象は`original_transfer_id`としてbodyに
持たせる——「新しいリソースをこのIDで作る」という`PUT`の意味論をStartと揃えるため。

`amount`のワイヤーフォーマット(文字列・`^-?\d+(\.\d{1,2})?$`・`AMOUNT_DECIMAL_PLACES`)は
[[0006-write-path-api-gateway-sqs-direct-integration]]決定5をそのまま踏襲する。レスポンスは
`202 Accepted` + `{"transferId": ..., "status": "accepted"}`(決定6と同型)。

### 5. CloudFrontのプレフィックス: `/transfer-command-api/*`・`/transfer-query-api/*`を追加する

[[0007-web-ui-stack-and-hosting]]が確立した「CloudFront Functionでprefixを剥がしてorigin側の
API Gatewayへ転送する」方式にそのまま2エントリを追加する。既存の`/command-api/*`・
`/query-api/*`とは別プレフィックスにすることで、CloudFront Function側の書き換えロジックも
API Gateway側のリソースツリーもaccount-serviceのものと独立に保てる(Transfer serviceが
account-serviceのコマンドAPIを経由しないという[[0010-transfer-service-saga]]の既存方針との
整合)。

### 6. Web UI: 顧客が開始した送金の一覧は「web-ui localStorageのみ」で表現する。口座単位のサーバー側一覧は今回のスコープ外

[[0009-web-ui-customer-experience-and-channel-emulation]]決定2(顧客-口座関係はバックエンドに
実装せず、web-uiのlocalStorageのみで表現する)と同じ考え方を、「顧客が開始した送金の履歴」にも
適用する。振替/振込フォーム送信時に生成した`transferId`・`kind`・`fromAccountId`・
`toAccountId`・`amount`をlocalStorageに保存し、UIはそれをキーに決定1の照会APIを
[[0010-transfer-service-saga]]決定5が言う「反映待ち」ポーリングUX(`refetchInterval`ベース、
エラーとして見せない)でポーリングして状態を表示する。振込(`kind: furikomi`)が
`pending_confirmation`の間は確認/取消ボタンを、`credited`かつ24時間の組戻し時間窓内
(`crates/transfer-service/src/saga.rs`の`RECALL_WINDOW`)は組戻しボタンを出す——ただし
時間窓の最終判定はサーバー側の`recall_eligibility`が権威であり、UI側の時刻比較は表示上の
ヒントに過ぎない(期限切れの組戻し要求はJ10の通りサーバー側で却下される)。

顧客向け画面自体は`CustomerFlow`配下に新設し(`ChannelEmulatorScreen`とは独立)、既存の
`AmountOperationForm`と同様の構成(口座選択→金額入力→確認)を踏襲する。振込確認画面の文言・
状態表示は[[no_internal_details_in_ui_text]]の方針(業務言語のみ、AWS/HTTP用語を出さない)に
従う。

**却下した代替案: `TransferSagaTable`に`fromAccountId`のGSIを追加し、口座単位の送金一覧を
サーバー側で提供する。** [[0009-web-ui-customer-experience-and-channel-emulation]]決定2が
account自体についてすでに同じ判断(顧客-口座関係はサーバー側に持たない)をしており、
「顧客が開始した送金の一覧」も同じ性質のデータ(顧客個人に紐づく、複数端末間の同期は
そもそも想定していない)である。GSI追加自体は技術的に難しくないが、このPoCで検証したい
論点(振替/振込のサーバー側判定、確認フロー、組戻し)には寄与しないため優先度を上げない。
複数端末からの利用や、口座の入出金履歴と統合した一覧表示が必要になった時点で再検討する。

## トレードオフ

- **決定1により、書き込み(サガのCAS更新)から`TransferStatusView`への反映までに近リアルタイム
  だが非ゼロの遅延が生じる**(DynamoDB Streams→Lambda。EventBridge Schedulerベースの
  アウトボックス(最大約1分)より大幅に短いが、瞬時ではない)。[[0010-transfer-service-saga]]
  決定5の「反映待ち」ポーリングUXでそのまま吸収できる範囲であり、新たな種類のトレードオフでは
  なく既存の結果整合性の物語の延長。
- **決定1により新しいLambdaとDynamoDBテーブルが1組増える**(`transfer-status-projector`・
  `TransferStatusView`)。`TransferSagaTable`を直接晒す案より部品数は増えるが、
  `transfer-owner-projector`と全く同じ形の既存パターンの再利用であり、新しい設計要素を
  持ち込むわけではない。
- **決定6のlocalStorage依存により、顧客が別端末・別ブラウザから送金状況を確認できない**。
  [[0009-web-ui-customer-experience-and-channel-emulation]]が口座一覧について既に受け入れている
  制約と同種であり、新たなトレードオフではなく既存の割り切りの延長。
- **`owner`インデックスの反映待ち中に送金を開始すると`transfer-command-intake`がリトライを
  続け、最終的にDLQへ積まれるまでサガ自体が作られない**(`command_intake.rs`の
  `process_start`)。この間、決定1の照会APIは404を返し続け、UIからは「まだ存在しないID」と
  「反映待ち」を区別できない。[[eventual_consistency_not_a_failure]]の方針通り、これを
  エラーとしてではなく「反映待ち」として表示し続ける。

## 次のステップ

1. 決定1(`TransferStatusView`・`transfer-status-projector`・照会API)を先に実装・デプロイし、
   `e2e`の`support/sagaState.ts`をこの新しい照会APIの呼び出しに置き換えられるか確認する
   (裏口の解消)。DynamoDB Streamsの順序保証・Lambdaトリガー無課金は本ADR執筆時点で公式
   ドキュメントを確認済みだが、`ParallelizationFactor`等の実際のCDK設定値は実装時に
   再確認する([[verify_aws_specs_before_implementing]])。
2. 決定2〜4(送金受付API)を実装し、`aws apigateway test-invoke-method`で実機検証する。
3. 決定6(web-ui)実装済み。残るのは実デプロイ環境上でJ1・J5〜J10の各シナリオがUI上の
   ハッピーパスとして再現できることを手動確認すること(`infra`の`npm run deploy`を先に
   実行し、最新のソースが反映された状態で確認する)。

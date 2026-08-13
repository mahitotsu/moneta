# ADR 0015: 人間可読な口座番号(支店+番号)の発番と、振込導線の自行/他行分岐

## ステータス

Accepted。`crates/query-service`に新規`bin/account_number_projector.rs`、
`infra/lib/account-pipeline-stack.ts`に`AccountNumbersTable`/
`AccountNumberProjectorFunction`/`AccountNumberObservationRule`/`AccountNumberQueryApi`と
関連CloudFrontルーティング、`web-ui`のOpenAccount後の口座表示・振込(furikomi)フォーム・
送金導線に反映する。account-domain・account-service・transfer-serviceの書き込み経路は
無変更。他行(対外)送金の実装自体は本ADRのスコープ外のまま
([production-readiness-matrix.md](../production-readiness-matrix.md) D4)。

## コンテキスト

[[0011-furikae-furikomi-distinction]]/[[0012-transfer-customer-api-and-status-query]]が
実装した振込(furikomi)の宛先入力は、`accountId`(ADR-0006決定2のクライアント生成UUID)を
そのまま生の文字列として直接入力させる作りだった。これは実用に耐えないというレビュー指摘を
受けた。さらに調べると、より根本的な欠落があった: 現状のどの顧客向け画面も自分の口座IDを
`formatAccountNumber(accountId).slice(-4)`で下4桁マスク表示するのみで、口座を受け取る側の
顧客が自分の口座IDを送金者に伝える手段自体が存在しなかった。

対応として「口座IDのUUIDを再エンコードして短縮表示する」案と「口座開設イベント購読による
短い発番口座番号を新設する」案を比較検討した結果、後者を選んだ。日本の実際の口座番号
(支店番号3桁+口座番号7桁)がレビューで参照されたことを受け、支店の概念も持たせることにした。

このPoCの検証テーマは「実用的なアプリをイベント駆動で作り切れるか」であり、UUID直接入力を
「対象外」として放置する判断は取らない方針とした。

## 決定

### 1. `accountId`(UUID)は識別子として変更しない

ADR-0006決定2を維持する。変更するとDynamoDBのパーティションキー・冪等性ログ・全E2Eの契約に
波及し、書き込み経路のドメインモデル変更になる(CLAUDE.mdがD8/D9/D10について述べる
「write-path domain modelの変更を要するドメイン機能はスコープ外」と同種の理由)。人間可読な
口座番号は、UUIDに代わる識別子ではなく、UUIDへの**読み取り専用の別名**として追加する。

### 2. 発番口座番号は、`account.event.Opened`購読だけで完結する新しい射影で持つ

`crates/query-service/src/bin/account_number_projector.rs`を新設した。
[[0011-furikae-furikomi-distinction]]決定2の`owner_projector.rs`(`account.event.Opened`
のみ購読し、不変データを専用の小テーブルへ一度だけ書く設計)と全く同型である。

query-serviceに置いた理由: `owner_projector.rs`がtransfer-service専用の名義データだったのに
対し、口座番号は特定のサービスに閉じない「顧客向けの口座読み取りモデル」の一部であり、
query-serviceが既に担っている境界([[0004-query-service-event-driven-projection]]/
[[0008-query-service-crate-extraction]])に自然に収まる。transfer-serviceに置くと、
transfer-serviceが自身の業務に不要な「口座番号」概念の所有者になってしまい境界がぼやける。

query-serviceの既存`AccountViewTable`(`view_from_event`による洗い替え投影)に相乗りしない
理由も`owner_projector.rs`のときと同じ: 口座番号は`Opened`一度きりで決まる不変データであり、
Deposited/Withdrawn等の書き込み時に消さずに引き継ぐには読み取り-書き込みマージが必要になり
複雑化する。専用テーブル(`AccountNumbersTable`)への一度きりの書き込みで足りる。

### 3. 口座番号は7桁の数字を、衝突再試行付きで発番する

`owner_id`と異なり口座番号は「一意な値を新規に採番する」必要があり、これはこのコードベースに
前例のない新規ロジックである。手順は「7桁の乱数候補を生成→
`ConditionExpression: attribute_not_exists(accountNumber)`付き`PutItem`で予約→条件不成立
(衝突)なら候補を作り直して再試行、上限到達で諦める」というループ。`account-service`の
OCCリトライ(`handler.rs`、ジッター付き・上限付き・`tracing::warn!`でリトライを都度記録)と
同じ形にした。7桁(1,000,000通り)は実際の日本の銀行の口座番号桁数に合わせた値であり、
このPoCの試験規模では衝突は稀だが、衝突再試行の機構自体を実際に動かして検証することに意味が
あるため、十分に衝突が起こり得る桁数のまま実装した(ここを大きくして衝突を起こりにくくする
ことはしない)。

### 4. 支店は固定の一覧から、口座IDを基に決定的に割り当てる

支店番号(3桁)+支店名の固定配列(本店/東京支店/大阪支店/インターネット支店)を
`account_number_projector.rs`が持ち、`account_id`のUUIDバイト列から決定的に
(`u128 mod 支店数`、乱数不要)1件選ぶ。決定的である理由: 支店は口座番号のような一意性を
要求しない(複数口座が同じ支店に属してよい)ため、衝突再試行の対象にする必要がなく、
同じ`account_id`なら常に同じ支店になることをunit testで直接検証できる形にした方が単純である。

**重要な単純化**: 実際の銀行では口座番号は支店内でのみ一意という建付けだが、本PoCでは
支店間の業務分離自体が存在しない単一銀行なので、口座番号の一意性は支店をまたいだ単一の
名前空間で保証する(決定3のconditional putは支店を考慮しない)。支店は表示・宛先入力の
実在感のためだけに付与される属性であり、一意性キーの一部ではない。これは誤魔化さず本ADRに
明記する意図的な割り切りである。

振込(furikomi)の宛先入力では、実際の銀行の「支店コード相違の検出」を模し、顧客が選んだ支店と
解決された口座の実際の支店が一致しない場合は送信をブロックする(web-ui側のみのチェック、
サーバー側の一意性キーには影響しない)。

### 5. 読み取り専用の新REST API(`AccountNumberQueryApi`)をLambdaレスDynamoDB直接統合で追加

[[0012-transfer-customer-api-and-status-query]]決定5の`TransferQueryApi`(GetItem直接統合)
と同じパターンを複製した。`GET /account-numbers/{accountNumber}`(口座番号→口座、宛先解決用)
と`GET /accounts/{accountId}/account-number`(口座→口座番号、自分の口座番号表示用、
GSI `byAccountId`へのQuery)の2エンドポイント。どちらも読み取り専用でLambdaは介在しない。

### 6. 振込(furikomi)の宛先入力を、口座番号ベースの検索・確認フローに変更する

`TransferForm`のfurikomi分岐を、生UUID直接入力から「支店選択→口座番号(7桁)入力→検索→
名義(`ownerId`)・支店の確認表示→送金」に変更した。実際に送信する`toAccountId`は解決された
`accountId`であり、`startTransfer`が送信するAPIリクエストの形自体は
[[0012-transfer-customer-api-and-status-query]]決定4の「共通」のまま変更していない——
口座番号ベースの検索は、UUIDを直接扱わせないための顧客向け画面の前段に過ぎない。

### 7. 振込の導線を自行/他行に分岐する。他行は非機能なプレースホルダとする

`TransferListScreen`の振替/振込タイルに「振込(他行あて)」を追加するが、選択しても
「サポートしておりません」という静的な案内を表示するのみで、バックエンド呼び出しは一切
発生しない。対外接続(全銀ネットワーク相当のインターバンクゲートウェイサービスの新設)は
[production-readiness-matrix.md](../production-readiness-matrix.md) D4に記載の通り
引き続き将来の検証候補であり、本ADRのスコープには含めない——導線を分けて存在を明示すること
と、対外接続そのものを実装することは別の意思決定として切り離した。

## トレードオフ

- **口座番号の一意性は支店をまたいだ単一の名前空間**: 決定4の通り、実際の銀行の「支店内一意」
  という建付けを再現していない。この銀行が単一組織で支店間の業務分離が存在しないための
  素直な帰結であり、支店をまたいだ一意性のせいで振込の宛先解決自体が誤動作することはない
  (支店の不一致はUI側の確認チェックとしてのみ機能する)。
- **支店は口座開設時に顧客が選べない**: 実際のネット銀行の多くも開設チャネルに応じて既定の
  支店(例: インターネット支店)を自動割り当てすることがあるが、本PoCでは`account_id`からの
  決定的な割り当てであり、顧客の意思を反映しない。`Command::Open`を変更しない(決定1と同じ
  理由)という制約からの帰結である。
- **口座番号発番の衝突再試行は7桁という現実的な桁数のまま**: 衝突確率を実質ゼロにする桁数
  (UUID相当)にせず、実際に衝突再試行が起こり得る規模を保った。試験実行の規模によっては
  ごく稀に採番に失敗しうるが、これは実際の銀行の口座番号発番が抱える制約と同種のものであり、
  意図的に残している。
- **口座番号↔accountIdの対応表は認証なしに誰でも引ける**: [[0007-web-ui-stack-and-hosting]]/
  [[0009-web-ui-customer-experience-and-channel-emulation]]が既に「認証UIなし」としている
  この PoC の信頼モデルの延長であり、新たな認可境界を追加するものではない。

## 却下した代替案

- **UUIDのBase32等での再エンコード**: フロントエンドのみの変更で完結し新規ADRも新規
  バックエンドコンポーネントも不要という利点はあったが、識別子自体が128bitある以上
  20文字強のコードが残り、実際の銀行の口座番号のような短い数字列にはならない。「実用的な
  アプリを作り切れるか」という検証テーマに対しては、新しいサービスがイベントを購読するだけで
  機能を足すという、このPoCが実証したいパターンそのものである決定2の方式を選んだ。
- **transfer-serviceに口座番号の対応表を持たせる**: `owner_projector.rs`と同じ実装パターンで
  作れる点は魅力だったが、口座番号はtransfer-service固有の業務(振替/振込の判定)には
  不要な概念であり、query-serviceの「顧客向け口座読み取りモデル」という既存の境界の方に
  自然に収まるため見送った(決定2)。
- **`AccountViewTable`に口座番号・支店を混ぜる**: [[0011-furikae-furikomi-distinction]]決定2が
  `owner_id`について下した判断と同じ理由(洗い替え投影との相性が悪い)で見送った(決定2)。
- **支店内でのみ口座番号を一意にする(支店番号+口座番号を複合一意性キーにする)**: 実際の
  銀行の建付けに最も近いが、この銀行には支店間の業務分離が実在しないため複合キーにする実質的
  な理由がなく、実装(衝突再試行ロジックが支店を考慮する必要が生じる)を複雑にするだけと判断
  し見送った(決定4)。

# ADR 0009: Web UIの顧客体験の再現(サインイン・口座一覧・取引履歴・外部チャネルエミュレータ)

## ステータス

Accepted。`web-ui/src/`の`customerSession.ts`・`components/CustomerFlow.tsx`・
`components/AccountListScreen.tsx`・`components/ChannelEmulatorScreen.tsx`他、
`crates/query-service/src/history.rs`、`infra/lib/account-pipeline-stack.ts`の
`AccountHistoryTable`/取引履歴APIに直接反映する。

## コンテキスト

[[0007-web-ui-stack-and-hosting]]で作ったWeb UIは、1画面に全コマンド(Open/Deposit/
Withdraw/Freeze/Unfreeze/Close)のボタンが並ぶ管理コンソールであり、ネットバンキングの
顧客体験を再現できていない、という指摘を受けた。以下の対応で合意した:

1. ダミーサインイン + 顧客ごとの口座一覧
2. 入出金操作は顧客向け画面から外し、代わりに「外部チャネル・エミュレータ」画面
   (ATM/他行からの振込/収納機関への支払い)を新設し、既存のDeposit/Withdrawコマンドを
   そのまま呼ぶ
3. 取引履歴の閲覧
4. 振込・振替(Transfer service)は別マイルストーンへ後回し

## 決定

### 1. 入出金は「外部チャネル」経由、顧客向け画面には置かない

現実のネットバンキングでは、顧客は自分のWeb UIセッションから直接「入金する」ボタンを
押すことはない——それはATM・他行からの振込・収納機関への支払い(自動引き落とし)など、
外部のチャネルを経由して発生する。`account-domain`の`Command::Deposit`/`Withdraw`は
元々「誰が・どのチャネルから」を一切問わない汎用プリミティブだったため、この区別は
**バックエンドを一切変更せず、Web UI側の画面構成(アクターの分離)だけで表現できる**。

- **顧客向け画面**(`CustomerFlow.tsx`、サインイン必須): 口座一覧・残高・取引履歴の閲覧、
  および凍結・凍結解除・解約(`FreezeForm`/`SimpleActionButton`)。これらは顧客が自分の
  意思で行うセルフサービス操作として引き続き顧客向け画面に残す。**Deposit/Withdrawの
  ボタンは置かない。**
- **外部チャネル・エミュレータ画面**(`ChannelEmulatorScreen.tsx`、サインイン不要——
  「外の世界」を表すため): ATM入金/出金・他行からの振込・収納機関への支払いの4フォーム。
  対象口座IDを直接入力し、中身はすべて既存の`deposit`/`withdraw`
  (`web-ui/src/api/client.ts`、無改修)をそのまま呼ぶ。銀行名・支払先名は表示上の飾りで
  あり、バックエンドへは送らない。

**振替(自分の口座間の資金移動)はここに含めない。** 振替は顧客自身が行う操作であり、
将来Transfer serviceを実装する際は顧客向け画面(セルフサービス)に置くべきものとして
区別する。振込(第三者の口座との資金移動)は外部チャネル側の関心事のまま残る。

### 2. 顧客-口座関係はバックエンドに実装せず、Web UIのlocalStorageのみで表現する

`account-domain`に「顧客」という概念を追加し、`Command::Open`に`customer_id`を持たせる
設計変更は行わなかった。`customerSession.ts`がlocalStorageだけで完結する
サインイン(`signIn`/`signOut`/`getSignedInCustomer`)と顧客ごとの口座リスト
(`getAccountsFor`/`addAccountFor`)を提供する。ブラウザ・端末をまたいでは共有されない
という制約を受け入れる——これはこのPoCの「技術的妥当性優先、組織的リアリズムは記事の
考察点」という方針([[0001-service-boundaries-and-event-driven-integration]]の
Notification/Transfer serviceと同じ扱い)と整合する割り切りである。将来Transfer
serviceを実装し、本物の顧客-口座関係が必要になった時点で見直す。

サインイン画面自体は非機能のダミー(何も検証しない)であることを明示し、実際の認証機構が
あるかのように見せない([[0007-web-ui-stack-and-hosting]]の「認証UIなし」という決定を
撤回するものではなく、「ダミーだと明示した上でUXだけ再現する」という追加のニュアンス)。

### 3. 取引履歴: Query Serviceに第二のread modelを追加する

`account_events`テーブルは既に追記専用(INSERT-only)で実質的な取引履歴を持っていたが、
[[0004-query-service-event-driven-projection]]の「他サービスのストアへの直接照会は不可、
すべてAPI経由」方針に従い、既存のcurrent-state view
(`AccountViewTable`、last-writer-wins)とは別に、新しいDynamoDBテーブル
`AccountHistoryTable`(PK `accountId`、SK `sk` = ゼロパディングしたナノ秒タイムスタンプ
+ `event_id`)を追加した。これは新しいアーキテクチャパターンではなく、ADR-0004が確立した
イベント駆動投影パターンの自然な延長である。

- `crates/query-service/src/history.rs`の`history_entry_from_event`が
  `projection.rs`の`state_to_view`と対になる変換を行う。`Event::Deposited`/`Withdrawn`
  自身はタイムスタンプを持たないため、全種別で`EventEnvelope::occurred_at`
  ([[0008-query-service-crate-extraction]]で`account-domain`に移した契約型)を
  統一して使う。
- ソートキーに`event_id`を含めるため、current viewのlast-writer-wins
  (ConditionExpression)と異なり、取引履歴への書き込みは**冪等な上書きで足りる**
  (at-least-once配信で同じイベントが再送されても同じキーへ上書きされるだけ)。
- 照会API(`GET /accounts/{accountId}/transactions`)はGetItemではなくDynamoDBの
  `Query`直接統合(VTL、Lambdaレス)。新しい順に最大50件(`ScanIndexForward: false`・
  `Limit: 50`)、ページネーションはPoCスコープでは省略した。レスポンスVTLで`#foreach`
  により各アイテムの`entry`属性(既にJSON文字列)をカンマ区切りで連結しJSON配列を
  組み立てる——[[0006-write-path-api-gateway-sqs-direct-integration]]がVTLの実機
  バグを繰り返し踏んだ経緯を踏まえ、デプロイ後に`aws apigateway test-invoke-method`
  で実機検証した。

## 却下した代替案

- **入出金ボタンを顧客向け画面に残したまま「ATMタブ」を追加するだけ**: ATMは表現できるが、
  他行からの振込・収納機関への支払いという第三者起点の資金移動を表現できない。決定1の
  「顧客セッションと無関係な外部アクター」という区別を維持するため、明確に別画面に分けた。
- **顧客-口座関係をバックエンドに実装する(`customer_id`をAccount aggregateに追加)**:
  `account-domain`のCommand::Open変更・スキーマ変更・投影ロジック変更を伴う相応の規模の
  変更になり、今回のスコープ(顧客体験の再現)に対して重すぎると判断し見送った。
- **`account_events`を直接照会するAPIを新設する**: ADR-0004が既に「他サービスのストアへの
  直接照会は不可、すべてAPI経由」と決定しており、この方針に反するため不採用。

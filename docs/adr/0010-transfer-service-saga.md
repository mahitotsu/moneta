# ADR 0010: Transfer service — 口座間送金のサガ(オーケストレーション)

## ステータス

Accepted。`crates/transfer-service`(新規、`saga.rs`/`persistence.rs`/`commands.rs`/
`src/bin/command_intake.rs`/`src/bin/saga_step.rs`)、`account-domain`の`EventEnvelope`への
`correlation_id`追加、`account-service`の`schema.sql`/`persistence.rs`/`outbox.rs`への
同フィールドの伝播、`infra/lib/account-pipeline-stack.ts`のTransfer serviceセクション
(`TransferSagaTable`/`TransferCommandQueue`/`TransferCommandIntakeFunction`/
`TransferSagaStepFunction`/`TransferSagaObservationRule`)に直接反映する。顧客向けAPI
Gateway/UIは決定6の通り未実装(次の増分)。

## コンテキスト

[[0001-service-boundaries-and-event-driven-integration]]が構想した4サービスのうち、Account
serviceとQuery serviceは実装済み([[0004-query-service-event-driven-projection]]、
[[0006-write-path-api-gateway-sqs-direct-integration]]、[[0008-query-service-crate-extraction]])
だが、Transfer/Notification serviceは意図的にスコープ外のまま据え置いていた。理由は、送金元・
送金先という2つの`Account` aggregateにまたがる操作は単一トランザクションで完結せず、補償を伴う
サガとして実装する必要があり、他の機能より設計難度が高いためである。まず単一集約の書き込み/
読み取りパス・自動テスト・CIを固めてから、このアーキテクチャが最も検証したかった主張——bounded
context をまたぐイベント駆動連携——に着手する方針を採った。

このADRの起草に先立ち、[[0002-sqs-message-lifecycle-and-error-classification]]の監査を行った
結果、`DomainError`による却下が[[0004-query-service-event-driven-projection]]のアウトボックスに
よって**既に**`account.rejection.*`としてEventBridgeへ発行されていることが判明した([[0002-sqs-message-lifecycle-and-error-classification]]決定7を参照)。アウトボックスが`kind`列を
区別しない汎用設計であるためで、Query Serviceが`account.event.*`だけを購読するよう絞っているから
気づかれていなかっただけである。これにより、Transferの補償トリガーはaccount-serviceを一切変更
せずに実現できることが分かった——以下の設計はこの発見を前提にしている。

## 決定

### 1. Transfer serviceは新設の独立サービスとし、account-service/query-serviceには一切変更を加えない

新しいRustクレート(`crates/transfer-service`)・新しいCDKリソース(独自のSQS FIFO+API Gateway
直接統合の書き込み経路、独自のDynamoDBサガ状態テーブル、独自のEventBridge Rule)として構築する。

account-serviceへのDeposit/Withdrawコマンド発行は、顧客向けコマンドAPI([[0006-write-path-api-gateway-sqs-direct-integration]])を経由せず、account-serviceのSQS FIFOキューへ**直接**
`SendMessage`する(Transfer serviceのLambda実行ロールに`sqs:SendMessage`権限を付与するだけ)。
理由: コマンドAPIはブラウザ/外部チャネルという顧客接点向けのHTTPインターフェースであり、
リクエストボディのJSON Schema検証・VTLによるSQSメッセージ組み立てを経由する
([[0006-write-path-api-gateway-sqs-direct-integration]]が述べる通り、このVTLは実機検証でしか
見つからない癖(二重引用符・改行の扱い等)を複数踏んだ経緯がある)。Transfer serviceは顧客の
ブラウザではなくバックエンドのサービス間連携であり、`AccountCommandEnvelope`(`account_id`・
`command`・決定4の`correlation_id`)のJSONを直接組み立ててSQSへ送るだけで済み、HTTPの層も
VTLの層も要らない。`MessageGroupId`(account_id)・`MessageDeduplicationId`(サガのステップ単位で
一意なIdempotency-Key相当の値)は`SendMessage`の呼び出しでそのまま指定する。

これにより account-serviceに対しては、既存の書き込み経路の入口を1つ増やすだけの、他の一般的な
発行元と変わらない立場を取る。観測は既存のドメインイベント(`account.event.*`)と却下イベント
(`account.rejection.*`)をEventBridgeで購読するだけで行う。

これにより、「シンプルな境界づけられたコンテキストを組み合わせて複雑な機能を実現する」という
[[0001-service-boundaries-and-event-driven-integration]]の主張を、実際にaccount-serviceを
一切触らずに証明する(唯一の例外は決定4、後述)。

### 2. サガはオーケストレーション方式とし、状態はTransfer service自身が持つ

コレオグラフィ(中央調整役を置かず、各サービスが他サービスのイベントに反応して自律的に次の行動を
決める方式)ではなく、Transfer service自身がサガの手順・状態を明示的に持つオーケストレーション
方式を採る。

理由: コレオグラフィは、補償が絡む協調ロジックをaccount-service側にも染み出させる方向に流れ
やすい(例:「このDepositは送金の一部なので失敗時はイベントの意味が変わる」といった認識を
account-serviceに持たせてしまう)。オーケストレーション方式でサガの複雑さをTransfer service
1サービスの中だけに閉じ込めれば、account-serviceは「これがTransferの一部かどうか」を一切
意識しない設計を維持できる。

サガ状態はQuery serviceと同じ技術選択(DynamoDB on-demand)で持つ。理由はこの用途に固有の
判断による。

- サガの状態更新は常に「1つの`transfer_id`につき1アイテム」の読み書きで完結し、複数行に
  またがるトランザクションは発生しない。DynamoDBの条件付き書き込み(`ConditionExpression`)で
  十分に表現できる。
- サガの項目は数フィールド程度でスキーマレスな用途に十分収まり、事前のスキーマ・IAM適用の
  仕組みを必要としない。

1トランザクション=1アイテムとし、状態は以下のいずれかを取る。

```
pending_debit → debited → pending_credit → credited (完了)
                                          → compensating → compensated (補償完了)
              → failed (出金自体が却下された場合、補償不要)
```

### 3. 送金は「出金→観測→入金→観測」の順で進め、入金側の却下は補償で処理する

1. 送金元へDepositコマンドの逆、`Withdraw`コマンドを発行し、サガ状態を`pending_debit`にする。
2. `account.event.Withdrawn`(成功)または`account.rejection.*`(却下)を観測する。
   - 却下(残高不足等)ならサガを`failed`にして終了する。まだ何も動いていないため補償は不要。
   - 成功ならサガを`debited`にする。
3. 送金先へ`Deposit`コマンドを発行し、サガ状態を`pending_credit`にする。
4. `account.event.Deposited`(成功)または`account.rejection.*`(却下、例: 送金先が凍結/解約)を
   観測する。
   - 成功ならサガを`credited`にして完了。
   - 却下なら送金元に対して同額の`Deposit`コマンド(補償)を発行し、`compensating`→
     (成功を観測して)`compensated`にする。補償の`Deposit`が却下されるケース(送金元が
     その間に凍結された等)は本ADRのスコープでは扱わない——運用上のアラートで手動対応する
     前提とし、`compensating`のまま滞留したサガを検知する仕組みは今後の課題とする。

### 4. `EventEnvelope`に相関IDを追加する(account-domain/account-serviceへの唯一の変更)

決定1で「account-serviceは無変更」としたが、相関IDの伝播だけは例外として認める。理由は以下の
通り。

- account_id(+コマンド発行後の時間窓)だけでイベントをサガに対応付ける方式は、同一口座に対する
  複数の同時送金がある場合に誤対応するリスクがある。金融ドメインのPoCとしてこれは避けるべきと
  判断した。
- この変更はTransferのビジネスロジックをaccount-serviceに持ち込むものではない。「このコマンドを
  発行したのは誰か」という出所情報を素通しするだけの、既存の`Idempotency-Key`パターン
  ([[0006-write-path-api-gateway-sqs-direct-integration]]決定3)の自然な拡張であり、
  `account-domain`の`apply`/`evolve`(ビジネスロジック本体)は一切関与しない、輸送のみの関心事
  である。したがって[[0003-domain-service-crate-boundary]]が定める「account-domainはAWS/DB非依存の
  純粋関数」という制約とも矛盾しない。

具体的には、コマンドのペイロードに任意の`correlation_id`(文字列、Transfer serviceが生成する
サガID)を持たせ、`Event`/`DomainError`を経て`EventEnvelope`までそのまま転記する。account-domain
の状態遷移ロジックはこの値を一切参照しない。

### 5. サガのタイムアウト・冪等性は既存パターンを踏襲する

Transfer serviceがaccount-serviceへ発行するDeposit/Withdrawコマンドには、サガのステップごとに
一意な`Idempotency-Key`を使う([[0006-write-path-api-gateway-sqs-direct-integration]]決定3の
パターンをそのまま利用)。これによりTransfer service自身のLambdaがリトライされても、account-
service側で二重にコマンドが処理されることはない。

サガ全体のタイムアウト(結果整合性の窓が単一操作より長くなる: 出力側アウトボックスの最大約1分の
遅延が複数ステップぶん積み重なりうる)は、Query serviceの`refetchInterval`ベースのポーリングUX
と同じ思想で扱う。UIは「反映待ち」を表示し続け、エラーとして見せない([F3](../e2e-scenarios.md)
のUI方針をそのまま継承する)。

### 6. 送金の受付はSQS FIFOへの直接`SendMessage`のみとし、API Gatewayは今回追加しない

[[0009-web-ui-customer-experience-and-channel-emulation]]は顧客向けTransfer画面自体を
将来の増分として明示的に据え置いている。UIが無い以上、今回HTTPのエントリポイントを追加しても
呼び出せるのは`curl`等の手動操作だけであり、優先度が低い。

加えて、Transfer自身の受付用に新しいAPI Gateway直接統合を書くことは、account-serviceの
コマンドAPIとは別の新しいVTLをもう1枚書くことを意味する。[[0006-write-path-api-gateway-sqs-direct-integration]]でVTLの癖(二重引用符・改行の扱い等)が実機検証でしか見つからなかった経緯を
踏まえ、検証環境を持たないままこの増分にさらにVTLのリスクを持ち込まない判断をした(決定1で
account-serviceへのコマンド発行についても同じ理由でVTLを避けている)。

このマイルストーンでは`transfer-command-intake` LambdaをTransfer自身のSQS FIFOキューに
直接つなぐ(このプロジェクトの最初のマイルストーンがAPI Gateway無しのSQS直接送信から始まり、
後から[[0006-write-path-api-gateway-sqs-direct-integration]]でAPI Gatewayを追加した順序と同じ)。
HTTP API Gatewayの追加(顧客向けUIとの接続を含む)は、Web UI側の対応(ADR-0009が据え置いた
部分)と合わせて次の増分に回す。

## トレードオフ

- **結果整合性の窓がAccount単体より長くなる**: 複数ステップの合計になるため、記事で明示的に
  説明する必要がある。
- **サガ状態と実際のAccount状態が瞬間的に食い違いうる**: 例えば`debited`状態のサガは、送金元の
  実際の残高は既に減っているが、Query Serviceのview反映にはまだアウトボックスの遅延が残る。
  最終的な収束は保証するが、常に同期しているわけではないことを明記する。
- **`compensating`のまま滞留するケースへの対応は本ADRのスコープ外**: 補償自体が失敗する
  ケースは運用上のアラート・手動対応を前提とし、自動リトライやDLQ的な仕組みは設計しない
  (PoCの規模に対して過大と判断)。
- **サガ状態のCAS成功後・次コマンド発行前にLambdaが落ちると、そのサガは永遠に進まなくなる**:
  `transfer-saga-step`はDynamoDBの条件付き書き込み(CAS)で遷移を確定させてから次のコマンドを
  発行する(二重発行を避けるため、決定3参照)が、CASとコマンド発行の間でLambdaが異常終了
  すると、遷移だけが確定して誰もコマンドを発行しない状態のまま止まる。同じイベントの
  再配信では回復しない(CASが既に成功済みのため、再配信されたイベントは「もう対応済み」
  として無視される——`saga.rs`の`expected_step`)。account-serviceのアウトボックスのような
  「発行してから確定」の順序(ADR-0004決定2)にすればこの窓は無くせるが、それには
  transfer-service自身がアウトボックスを持つ必要があり、PoCの規模に対して過大と判断し
  見送った。`compensating`の滞留と同様、運用上の検知・手動対応を前提とする既知のギャップ
  として記録する。

## 却下した代替案

- **コレオグラフィ方式**: account-service自身に「これはTransferの一部」という認識を持たせる
  方向に流れやすく、境界づけられたコンテキストの独立性を汚すため不採用(決定2)。
- **2相コミット/XA的な分散トランザクション**: 今回のストア(DynamoDB)はそもそも
  サービスをまたぐクロスaggregateのトランザクションをサポートせず、イベント駆動の
  設計思想全体とも相容れないため検討していない。
- **相関IDを使わずaccount_id+タイミングのみで対応付け**: 同一口座への複数同時送金で誤対応する
  リスクがあり、金融ドメインのPoCとして避けるべきと判断し、決定4で相関IDを追加することにした
  (決定4)。
- **`RejectionSink`のような専用の却下発行機構を新設する**: [[0002-sqs-message-lifecycle-and-error-classification]]の監査により、既存の汎用アウトボックスが既に`account.rejection.*`を
  発行済みであることが判明したため、不要と判断した。
- **顧客向けコマンドAPI([[0006-write-path-api-gateway-sqs-direct-integration]])経由でコマンドを
  発行する**: HTTPの層・JSON Schema検証・VTLを余分に経由するだけで、Transfer serviceのような
  バックエンド間連携には何も得るものがない。VTLは実機でしか踏めない癖の温床であることが
  ADR-0006で既に判明しており、検証環境を持たないままここへ新しい分岐を持ち込むリスクを
  避けた(決定1)。
- **サガ状態専用の新しいAurora DSQLクラスタを持つ**: 単一アイテムの読み書きしか発生しない
  サガ状態にリレーショナル・トランザクション機構は不要であり、専用のスキーマ・IAM自動適用の
  仕組みをもう一セット持つ重さに見合わないため見送った(決定2)。

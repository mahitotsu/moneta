# ADR 0006: 書き込み経路API Gateway — Lambdaレス SQS直接統合

## ステータス

Accepted。`infra/lib/account-pipeline-stack.ts`の`AccountCommandApi`に直接反映する。

## コンテキスト

書き込み経路（`Web UI → API Gateway → SQS FIFO → Lambda(Rust) → Aurora DSQL`）は、API
Gateway自体を除いてエンドツーエンドで実装済みだった。SQS FIFOキュー
（`moneta-account-commands-main.fifo`）には、このマイルストーンまで実質的なプロデューサーが
存在せず（`aws sqs send-message`を手動実行するのみ）、書き込み経路は一度も実クライアントから
検証されていなかった。

[[0002-sqs-message-lifecycle-and-error-classification]]のメッセージライフサイクル図は、
そもそも`API Gateway（構造検証・型/必須項目チェック）→ SQS FIFO`という形（Lambdaを挟まない）
を想定していた。読み取り経路（[[0004-query-service-event-driven-projection]]、`AccountQueryApi`
→ DynamoDB `GetItem`のVTL直接統合）はこの「Lambdaレスで直接統合する」という思想を先に実証
済みであり、書き込み経路もこれに揃える。

## 決定

### 1. Lambdaレス：APIGW → SQS `SendMessage` 直接統合

読み取り経路との対称性、および書き込み経路にLambdaのコールドスタートを追加しないための
判断。ただしSQSはQueryプロトコル（form-urlencoded）のAPIであり、DynamoDBのJSON APIとは
統合の形が異なることをAWS公式ドキュメント（AWS Prescriptive Guidance「Integrate Amazon API
Gateway with Amazon SQS」）および動作するCDK実装例で確認した上で採用した。

```ts
new apigateway.AwsIntegration({
  service: "sqs",
  path: `${cdk.Aws.ACCOUNT_ID}/${commandQueue.queueName}`, // SQSクラシックエンドポイントの形
  integrationHttpMethod: "POST",
  options: {
    requestParameters: {
      "integration.request.header.Content-Type": `'application/x-www-form-urlencoded'`,
    },
    requestTemplates: {
      "application/json": "Action=SendMessage&MessageGroupId=...&MessageDeduplicationId=...&MessageBody=...",
    },
  },
});
```

`QueueUrl`はform paramとして渡すのではなく、`path`にアカウントID＋キュー名を埋め込む。
SQSの`SendMessage`レスポンス（XML）から`MessageId`をパースする実装はせず、クライアントへの
応答は固定のacceptedボディ（後述）にすることでこの複雑さを避けた。

却下した代替案：**簡易な検証用Lambdaを前段に挟む**。VTLでのネスト構造やクォート処理を
避けられ可読性は上がるが、ADR-0002の図が想定していた構成から外れ、読み取り経路との
Lambdaレス対称性が崩れる。書き込み経路に新たなLambdaコールドスタートの経路を1つ増やす
コストに見合う理由がないため不採用。

#### 実機検証で判明した3つの不具合と対処（推測に頼らず`test-invoke-method`で確認）

デプロイ後、`PUT /accounts/{accountId}`を実際に呼び出したところ`500 Internal server error`
になった。`aws apigateway test-invoke-method`で実行ログを取得し、`aws apigateway
update-integration`でテンプレートを1行ずつ差し替えながら原因を切り分けた結果、以下の
3つが判明した。

1. **`$util.urlEncode("...")`のようなVTLの二重引用符文字列リテラル内で、`\"`による
   エスケープが機能しない**（`Execution failed due to configuration error: Unable to
   transform request`）。MessageBodyはJSON-in-JSONではないため二重エスケープ自体は
   不要と判断していたが、それとは別に「変数展開のため二重引用符が必要な文字列の内側に、
   JSON構文としての二重引用符を埋め込む」という一重の衝突が残っており、これがVTLエンジンの
   パーサーでサポートされていなかった。
   対処：`#set($q = '"')`で二重引用符1文字を単一引用符リテラル（エスケープ不要）として
   変数に退避し、JSON構文上の引用符が必要な箇所には`${q}`という変数参照を埋め込む。
   パーサーは文字列境界を字句解析の時点で判定するため、`$q`という参照トークンは引用符の
   衝突を起こさず、実行時の変数展開によって初めて実際の`"`文字がレンダリングされる。
   `aws apigateway test-invoke-method`で実際にSQSへ届くリクエストボディ
   （`MessageBody=%7B%22account_id%22%3A...`）をURLデコードし、意図した
   `AccountCommandEnvelope`のJSON形状と一致することを確認済み。
2. **`#set`行を含むVTLテンプレートの各行をすべて`\n`で結合すると、`Action=SendMessage`など
   フォームフィールドの値の末尾に改行文字が混入する**。`#set($q = '"')`はVTLディレクティブ
   として改行で終端する必要があるため、テンプレート全体を配列にして`.join("\n")`していたが、
   これにより`Action=SendMessage`の直後にも改行が入り、SQS側は値を`"SendMessage\n"`として
   受け取ってアクションを認識できず、無関係な`"Version is missing"`というエラーを返した
   （再デプロイ後の実機検証で発見。`MessageDeduplicationId`欠落時に出る
   `"MessageGroupId is missing"`ではなく`Version`不足という予期しないエラーだったことが
   手がかりになった）。
   対処：改行が必要なのは`#set`行の直後だけであり、それ以降のフォームフィールド群は1行に
   連結する（`.join("")`、`#set`側の文字列に`\n`を含める）。
3. **`integrationResponses`に`selectionPattern`を指定しない1エントリだけを置くと、
   SQS側の実際のステータスコードに関わらず常にそのエントリがデフォルトのcatch-allとして
   適用される**。`MessageDeduplicationId`欠落によりSQSが`400`を返すケースで検証したところ、
   クライアントには`202 accepted`が返り、実際には失敗している書き込みが「受理された」と
   誤って伝わることを実機で確認した。
   対処：成功エントリに`selectionPattern: "2\\d{2}"`を明示し、SQSからの非2xxはこのエントリに
   一致させない。あわせて非2xx用の`502`エントリ（`selectionPattern`なし、デフォルト扱い）を
   追加し、`{"message": "failed to enqueue command"}`を返すようにした。

いずれも一般知識からの推測だけでは気づけなかった挙動であり、実機での`test-invoke-method`
検証が本質的だった（CLAUDE.mdの「AWS/ライブラリの挙動は推測せず検証する」指針と一致）。

### 2. 口座IDはクライアント生成、`PUT /accounts/{accountId}`で開設

`AccountCommandEnvelope`（`crates/account-service/src/persistence.rs`）は`Open`を含む
全コマンドで`account_id`を事前に要求する設計になっており、バックエンド側がIDを採番する
コードパスはそもそも存在しない。この既存設計を素直に踏襲し、ブラウザが`crypto.randomUUID()`
でUUIDを生成し、`PUT /accounts/{accountId}`でその口座を開設する。

却下した代替案：**API Gatewayの`$context.requestId`をaccount_idとして使い、
`POST /accounts`で生成する**。典型的なREST APIの「POSTで作成→新しいIDが返る」という直感には
合うが、`$context.requestId`はリクエストごとに変わるため、クライアントがタイムアウト後に
再送すると別IDで2つ目の口座が作られてしまう。金融ドメインのPoCとしてこの再送非べき等性は
看過しにくく、Lambdaレスである以上サーバー側で「同一リクエストか」を判定する手段もないため
不採用。

### 3. `Idempotency-Key`ヘッダー（必須）→ SQS `MessageDeduplicationId`

書き込み経路のSQSキュー`moneta-account-commands-main.fifo`は
`contentBasedDeduplication: false`（プロデューサー側が明示的に`MessageDeduplicationId`を
設定する前提、と元々CDKコメントに明記されていた）。VTLにはハッシュ化・UUID生成の手段が
ないため、この値をサーバー側で導出することはできない。クライアントに`Idempotency-Key`
ヘッダーを必須で要求し（Request Validatorの`requestParameters`で強制）、そのまま
`MessageDeduplicationId`にマップする。

### 4. コマンドごとに個別のRESTリソースに分ける（1つの多態的エンドポイントにしない）

| Method | Path | コマンド |
|---|---|---|
| PUT | `/accounts/{accountId}` | `Open` |
| POST | `/accounts/{accountId}/deposits` | `Deposit` |
| POST | `/accounts/{accountId}/withdrawals` | `Withdraw` |
| POST | `/accounts/{accountId}/freeze` | `Freeze` |
| POST | `/accounts/{accountId}/unfreeze` | `Unfreeze` |
| POST | `/accounts/{accountId}/close` | `Close` |

1つのエンドポイントに全コマンドを通す設計だと、Request Validatorのモデルが`oneOf`による
判別共用体（discriminated union）になり、API Gatewayの JSON Schema（Draft-4）実装との
相性が悪くなる。コマンドごとにリソースを分ければ、各モデルはフラットな必須項目チェックで
済み、ADR-0002が想定する「構造検証・型/必須項目チェックのみ」という境界にも素直に収まる。

### 5. ワイヤーフォーマットの詳細

- 金額・残高（`amount` / `initial_balance`）はJSON上「文字列」であって数値ではない
  （`rust_decimal`の`serde-with-str`機能。`crates/account-domain/Cargo.toml`、既存テスト
  `event_serializes_amount_as_string_not_float`で確認済み）。Request Validatorのモデルでは
  `type: string`＋`pattern: "^-?\d+(\.\d{1,2})?$"`で構造的に検証する（正の値かどうかは
  `DomainError::InvalidAmount`として既にドメイン層が扱う業務ルールであり、ここでは踏み込まない）。

  **精度は小数点以下ちょうど2桁までと定義する**（`account-domain`の`AMOUNT_DECIMAL_PLACES`
  定数が単一の真実源）。当初はこの精度自体を定義しておらず、実デプロイでDBラウンドトリップ
  由来のスケールのブレ（保存済み`balance`が`900.000000`のような形で読み戻される）を発見した
  ことを契機に、APIの仕様として明示した。`Account::apply`/`apply_to_absent`は
  `new_balance`/`balance`を必ず`Decimal::rescale(AMOUNT_DECIMAL_PLACES)`で正規化し、
  3桁以上の入力は`DomainError::InvalidAmountPrecision`として却下する。

  `rescale`ではなく`round_dp`を最初に使い、これも実デプロイで見つかった不具合として訂正した:
  `round_dp`は精度を落とす方向にしか働かず（`old_scale <= dp`なら値をそのまま返す実装、
  rust_decimal 1.42.1の`round_dp_with_strategy`）、桁が足りない場合（`"1000"`, scale=0）に
  ゼロ埋めして`"1000.00"`にすることをしない。`rescale`は両方向（不足はゼロ埋め、超過は丸め）
  で厳密に目標スケールへ揃えるため、精度の強制にはこちらが正しい。

  [[0010-transfer-service-saga]]のTransfer serviceはこのコマンドAPI（したがってこの
  Request Validator）を経由しない（決定6参照）ため、`transfer-service`の`saga::start`でも
  同じ`AMOUNT_DECIMAL_PLACES`を参照して同じ検証を行う——単一の真実源はaccount-domain、
  検証の実施箇所は経路ごとに必要。
- `FreezeReason`の値（`SuspectedFraud` / `CourtOrder` / `CustomerRequest`）はRustのenum
  バリアント名とそのまま一致させる（`rename_all`は付いていない）。
- `Command::Unfreeze`/`Command::Close`はユニットバリアントであり、`Command`に
  `#[serde(tag = ...)]`が付いていないため、serdeのデフォルト外部タグ付け表現では
  素のJSON文字列になる（`"command":"Unfreeze"`であって`{"Unfreeze":{}}`ではない）。VTL側の
  `MessageBody`組み立てもこれに正確に合わせている。

### 6. レスポンス契約：`202 Accepted`

書き込みは非同期であり、[[0001-service-boundaries-and-event-driven-integration]]が既に
文書化している結果整合性のトレードオフ（「口座に反映されたはずの取引がまだ照会に出ない」）
がそのまま当てはまる。SQSへの`SendMessage`が成功した時点で`202 Accepted`＋
`{"accountId": ..., "status": "accepted"}`を返し、クライアントは`AccountQueryApi`の
`GET /accounts/{accountId}`をポーリングして反映を確認する。

## 今回のスコープ外として残す既知のギャップ

- **`accountId`パスパラメータのUUID形式検証はしない**：API GatewayのRequest Validatorは
  パスパラメータを正規表現で制約できない（JSON Schemaが効くのはボディのみ）。不正な形式の
  UUIDが送られた場合、`persistence.rs`側の`serde_json::from_str`が失敗し、既存のインフラ
  起因失敗の分類（[[0002-sqs-message-lifecycle-and-error-classification]]決定1）に従って
  リトライ→DLQに送られる。クライアント起因の構造的ミスがインフラ起因失敗として扱われる
  非対称はあるが、Lambdaレス構成である以上ここでの是正は難しく、Web UI側が有効なUUIDだけを
  生成する前提で当面は許容する。
- **CORS設定はまだ行わない**：現時点でこのAPIを呼ぶクライアントは存在せず、実際にブラウザ
  からクロスオリジンで呼ばれるWeb UIマイルストーンまで意図的に先送りする。

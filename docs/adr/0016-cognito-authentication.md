# ADR 0016: Amazon Cognitoによる実認証の導入

## ステータス

Accepted。`crates/auth-service`(新規crate)、`crates/query-service`の
`customer-accounts-projector`、`crates/account-domain`の`DomainError::NotOwner`、
`crates/account-service/src/persistence.rs`の`requested_by`検証、
`infra/lib/account-pipeline-stack.ts`のCognito User Pool/Authorizer/`CustomerAccountsTable`、
`web-ui`の`auth.ts`/`SignInForm.tsx`/`AccountListScreen.tsx`に実装する。
[[0007-web-ui-stack-and-hosting]]の「認証UIなし」、[[0009-web-ui-customer-experience-and-channel-emulation]]決定2の「顧客-口座関係はバックエンドに実装せず、Web UIのlocalStorageのみで
表現する」、[[0011-furikae-furikomi-distinction]]の「`owner_id`は引き続き認証されない自己申告
のダミー識別子である」を、本ADRで正式に覆す。

## コンテキスト

[[0015-friendly-account-numbers-and-branch-and-other-bank-placeholder]]で発番口座番号
(7桁)を導入した際、この番号が全数探索可能(1000万通り)であることが判明した。認証・認可が
一切ないこのPoCでは、`GET /account-numbers/{番号}`を総当たりすれば実在する全口座の
`accountId`・`ownerId`・支店を収集でき、さらにWeb UIの「既存の口座をこの一覧に追加」機能
(生の`accountId`を手入力するだけで、誰の口座かの検証は一切ない)を使えば、他人の口座を
自分のセッションに紐付けて閲覧はもちろん凍結・凍結解除・解約まで行えてしまう。

この指摘を受けた議論で、「実用的なアプリをイベント駆動で作り切れるか」というこのPoCの検証
テーマに立ち返り、認証を「対象外」として片付けるのではなく実装する方針を確定した。あわせて、
認証イベント(サインアップ・サインイン)自体をこのアーキテクチャの検証対象に含めることで、
このPoCが繰り返し実証してきた「新しいサービスが既存のイベント駆動パターンに素直に乗る」
という主張を、認証という新しい切り口でも実証する。

## 決定

### 1. Amazon Cognito User Poolによるセルフサインアップ認証

ユーザー名+パスワードのみ(メールアドレス確認を要求しない——SESのセットアップを要する
email verificationはPoCスコープ外として明示的に見送る)。`PreSignUp`トリガーで
`autoConfirmUser: true`を返し、確認コードの入力ステップ自体を無くす。`UserPoolClient`は
`authFlows: { userPassword: true }`(SRPではなく単純なユーザー名+パスワード送信、TLSで
保護される前提の単純化)を使う——Amplifyの重いSRPクライアントライブラリを新規依存に
追加しない選択であり、意図的なトレードオフとして明記する。

### 2. 顧客向けAPIエンドポイントには`CognitoUserPoolsAuthorizer`を必須にする

`AccountQueryApi`・`AccountCommandApi`の`Open`/`Freeze`/`Unfreeze`/`Close`・
`TransferQueryApi`・`TransferCommandApi`・`AccountNumberQueryApi`・新設
`GET /customers/me/accounts`——全て有効なCognito JWTを要求する(11エンドポイント)。

**`Deposit`/`Withdraw`(外部チャネル、[[0009]]決定1「外の世界」)は引き続き認証不要のまま
据え置く。** 実際のATM・他行振込チャネルが顧客のブラウザセッションで認証されることはなく、
この2つのコマンドは「顧客のセルフサービス操作」ではなく「外部から届く入出金」を表現する
ものだったため、認証を要求すると[[0009]]決定1のモデル自体と矛盾する。

### 3. `owner_id`はもはや顧客の自己申告ではなく、認証済みJWTのclaimが正とする

API GatewayのVTLが`$context.authorizer.claims.sub`を`requested_by`としてSQSメッセージ本文
に注入する(顧客が送るリクエストボディの一部ではない、別チャネルの値)。account-serviceの
`persistence::apply_command`は:
- `Open`: リクエストボディの`owner_id`を無視し、常に`requested_by`を使う
  (`persistence::resolve_owner_id`)——認証済みだが他人のowner_idを名乗って口座を開設する
  なりすましを防ぐ。
- `Freeze`/`Unfreeze`/`Close`: 現在の口座の`owner_id`と`requested_by`が一致しない場合、
  新設`DomainError::NotOwner`として却下する(`persistence::is_ownership_violation`)。
  他の`DomainError`と同じく[[0002-sqs-message-lifecycle-and-error-classification]]の
  分類にそのまま乗り、`account.rejection.NotOwner`として発行される。
- `Deposit`/`Withdraw`: 外部チャネル(認証なし)のままなので`requested_by`自体を注入せず、
  チェックも行わない。

`Account::apply`/`evolve`自体は無改修——認可はドメインの外(account-serviceのサービス層)の
関心事として意図的に切り離す。`owner_id`が不透明な文字列である[[0011]]の設計はそのまま
活きており、変わるのは「その文字列がどこから来るか」(顧客の自己申告→Cognitoの検証済み`sub`)
だけである。

### 4. 「本物の顧客-口座関係」を`CustomerAccountsTable`で実装し、localStorageの手入力機能を廃止する

[[0009]]決定2が「将来Transfer serviceを実装する際、本物の顧客-口座関係が必要になれば見直す」
と明記していた見直しに、認証の導入をもって着手する。`account.event.Opened`だけを購読する
新しい投影(`crates/query-service/src/bin/customer_accounts_projector.rs`、
`owner_projector.rs`/`account_number_projector.rs`と同型)が`CustomerAccountsTable`
(PK `ownerId`、SK `accountId`)を埋める。`GET /customers/me/accounts`
(Lambdaレス、DynamoDB Query直接統合)は、`ownerId`をリクエストパラメータからではなく
`$context.authorizer.claims.sub`から取る——クライアントは他人の`ownerId`を指定できない。

**Web UIの「既存の口座をこの一覧に追加」(生の`accountId`を手入力する機能)は廃止する。**
口座は開設した瞬間に`CustomerAccountsTable`へ反映され、サインインした本人の一覧に自動的に
現れるため、この機能はもう不要であり、かつ今回発覚した脆弱性の直接の原因だった機能を
作り込みではなく削除で解消する。

### 5. 認証イベントを新しい`auth-service` crateから発行する

`crates/auth-service`(`account-domain`に依存しない——認証はアカウントのドメインとは独立の
関心事、[[0003-domain-service-crate-boundary]]のcrate境界の考え方をそのまま踏襲)。
CognitoのLambdaトリガー(`PostConfirmation`/`PostAuthentication`)から、既存の
`domainEventBus`へ直接`PutEvents`する:`auth.event.SignedUp`/`auth.event.SignedIn`。

account-serviceのようなDynamoDBアウトボックス(account_events→Streams→PutEvents)は
使わない——Cognitoのトリガー呼び出し自体が真実源であり、二重書き込み問題(アウトボックス
パターンが解決しようとしている問題)がそもそも存在しないため、直接`PutEvents`で十分。
PutEvents失敗はログのみに留め、サインアップ/サインイン自体を失敗させない(ベストエフォート)。

**この2つのイベントは現時点では誰も購読しない。** 今回のスコープは「発行できることの実証」
までとし、購読側の具体的な活用(例: サインイン履歴の顧客向け表示)は
`production-readiness-matrix.md`に将来の検証候補として記録するに留める。

## トレードオフ

- **読み取り系の項目単位の認可は実装しない**: 認証済みの別人が他人の`accountId`を直接URLに
  指定して`GET /accounts/{id}`を叩けば、依然として閲覧できてしまう(「認証」は満たすが
  「この口座は自分のものか」という認可は満たさない)。Lambdaレスの直接統合という設計
  ([[0004-query-service-event-driven-projection]]/[[0006-write-path-api-gateway-sqs-direct-integration]])はアイテム単位の認可をVTLで表現しづらく、これを実装するには
  クエリ系エンドポイントをLambda経由に変える必要がある——それは「Lambdaレス直接統合」という
  このPoCが検証している設計そのものを手放すことになるため、今回は見送った。書き込み系
  (Freeze/Unfreeze/Close)は決定3の`requested_by`検証で認可済みだが、読み取り系は認証止まり
  である、という非対称を正直に記録する。
- **CloudFrontのAuthorizationヘッダー転送は完全な無キャッシュにできない**: 実装時に2段階の
  AWS挙動が判明した。(1) CDKの`OriginRequestPolicy`は`allowList`に`Authorization`を含めると
  synth時点で拒否する——このヘッダーは`CachePolicy`側の`headerBehavior`でのみ転送できる。
  (2) その`CachePolicy`のTTLを全て0(`CachePolicy.CACHING_DISABLED`相当)にすると、今度は
  実際のデプロイ時点で「HeaderBehaviorはcaching disabledなポリシーには無効」というCloudFront
  自身のバリデーションで拒否される(cdk synthは通過するため、実デプロイして初めて発覚した)。
  やむを得ずTTLを1秒だけ持たせている——結果整合性の最大約1分のラグを既に許容しているこの
  システムからすれば無視できる窓であり、`headerBehavior`に`Authorization`を含めることで
  キャッシュキー自体がトークンごとに分かれる(他人のレスポンスが誤って返る心配もない)ため、
  ADR-0007が意図した「結果整合性のあるレスポンスをCDNにキャッシュさせない」という性質を
  実質的に保っている。
- **`GET /customers/me/accounts`はこの非対称の例外**: `ownerId`をクライアント入力ではなく
  JWT claim由来にすることで、この1エンドポイントに限っては項目単位の認可を実現している
  (VTLで表現できる形にたまたま収まったため)。
- **パスワード認証は`USER_PASSWORD_AUTH`(SRPではない)**: 決定1の通り、Amplifyの重い
  SRPクライアントを新規依存に追加しない単純化。TLSに守られる前提であり、SRPが守ろうとする
  「パスワードそのものをネットワークに一切流さない」性質は失われる。
- **トークンは`localStorage`に保持する**: httpOnly cookie等より安全性は劣るが、この
  Lambdaレスアーキテクチャでサーバー側がcookieを発行する経路がなく、PoC規模の単純化として
  受け入れる。
- **認証イベントの購読先が無い**: 決定5の通り、発行のみで購読側の実用例は次の増分に持ち越す。

## 却下した代替案

- **Amazon Cognito Identity Pool(IAMクレデンシャルの一時発行)のみで済ませる**: 「サインイン」
  という顧客体験そのものを実証したかったため、User Pool(認証)が必須であり、Identity Pool
  単体では不十分と判断した。
- **AWS Amplify(Auth)ライブラリの導入**: SRP・トークンリフレッシュ等を丸ごと肩代わりして
  くれる利点はあったが、このPoCが一貫して避けてきた「重量級フレームワークへの依存」
  (ルーターもcontext APIも使わず素のReact stateで組んでいる、[[0007]])と方向性が合わないため、
  `@aws-sdk/client-cognito-identity-provider`を薄く直接使う方式を選んだ。
- **account-domainに`requested_by`/認可ロジックを持たせる**: `Account::apply`が認証済み
  ユーザーの概念を知る設計にすると、account-domainの「ゼロAWS/DB依存」という境界
  ([[0003]])に認証という新しい関心事が混入する。認可判定を`account-service`のサービス層
  (`persistence::apply_command`の前段)に留め、`DomainError::NotOwner`という結果だけを
  ドメイン層の語彙で表現する方式を採った。

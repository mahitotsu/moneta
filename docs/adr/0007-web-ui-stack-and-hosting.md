# ADR 0007: Web UIのスタック選定とホスティング(CloudFrontによるCORS回避)

## ステータス

Accepted。`web-ui/`(新規ディレクトリ)と`infra/lib/account-pipeline-stack.ts`のWeb UIホス
ティングセクション(`WebUiBucket`/`WebUiDistribution`以下)に直接反映する。

## コンテキスト

書き込み・読み取り両経路のバックエンドは実AWSで検証済み(コミット3214e58時点)で、
CLAUDE.mdの一行アーキテクチャ概要における唯一の空欄だったWeb UIに着手する。フレームワー
ク・状態管理・認証の扱い・CORSの扱いについて、ユーザーと合意した内容を記録する。

## 決定

### 1. フレームワーク: React + TypeScript + Vite

Svelte/SvelteKit・Vue 3・Leptos(Rust/WASM)も検討したが、この記事で検証したいのは
非同期・結果整合性のUXやCloudFrontの構成であってフロントエンドフレームワーク自体では
ないため、最も情報量が多くAI支援コーディングとの相性が良い(バックエンドのRust選定理由
——[[project-moneta-poc]]memory参照——と同じ「AI実装との相性」軸)、最も枯れた選択を
採った。Leptosは「フルスタックRust」という記事的な面白さはあるが、エコシステムの未成熟
さによるフリクションが記事の核心(バックエンドのイベント駆動アーキテクチャ検証)と無関係
な時間を食う懸念が上回ると判断した。

### 2. 状態管理: TanStack Query(サーバー状態) + Reactの`useState`(ローカル状態)、グローバルストアなし

このアプリの本質的な複雑さは、書き込みが`202 Accepted`のみを返す結果整合性
([[0001-service-boundaries-and-event-driven-integration]])の下で、`GET
/accounts/{id}`をポーリングして反映を確認するUXそのものである。TanStack Queryの
`refetchInterval`/`isFetching`はこれに直接一致する。マルチユーザーセッションや複雑な
UI状態機械はこのPoCには無いため、Zustand/Jotai・Redux Toolkitのようなグローバルストア
は過剰と判断した。手組みの`fetch`+`setInterval`は、ポーリング・再試行の端境ケースを
自前実装することになり、AWS仕様を推測せず検証するという方針(このプロジェクトが繰り返し
学んできた教訓、[[feedback-verify-aws-specs-before-implementing]])と同型の罠を、
ライブラリ選定の場面で再演することになるため避けた。

### 3. 認証: 認証UIを持たない。単一オペレーター向けコンソールとして扱う

見た目だけのログイン画面や、クライアント側の簡易ゲート(ハードコードされた合言葉等)も
検討したが、どちらも「無いものをあるように見せる」偽の安心感を作ってしまう。
[[0001-service-boundaries-and-event-driven-integration]]がTransfer/Notification
serviceを明示的にProposed/out of scopeとしている姿勢、CLAUDE.mdの「組織的リアリズムは
記事の考察点」という方針と一貫させ、認証機構が無いことを実装上も文書上も隠さない。

### 4. CloudFrontによるオリジン統合でCORSを構造的に不要にする

`queryApi`(`AccountQueryApi`)と`commandApi`(`AccountCommandApi`)はどちらもリソース
パスが`/accounts/{accountId}`から始まる(GETが照会、PUTがOpen)。ユーザー提案の
「CloudFrontで静的コンテンツとAPIを単一オリジンに統合し、CORSを不要にする」を検討した
ところ、CloudFrontのcache behaviorはHTTPメソッドではなくパスでしか振り分けられないた
め、素朴な単一`/accounts/*` behavior案ではこの2つのAPIを区別できないことが分かった
(着手前の設計検討で気づけた)。

対処として、ブラウザから見えるパスにAPI種別ごとのprefix(`/query-api`・`/command-api`)
を与え、CloudFront Function(`cloudfront-js-2.0`ランタイム、viewer-request)でprefixを
剥がしてから`origins.RestApiOrigin`経由で各API Gatewayへ転送する
(`QueryApiPrefixFunction`/`CommandApiPrefixFunction`)。デフォルトbehaviorは
`origins.S3BucketOrigin.withOriginAccessControl`で静的サイト(`web-ui/dist`)を配信する。

これによりブラウザは常に単一オリジン(CloudFrontドメイン)だけを叩くことになり、CORS
プリフライトが構造的に発生しない(同一オリジンのリクエストはブラウザのCORS機構の対象外
——`Idempotency-Key`のようなカスタムヘッダーを使うPUT/POSTも同様)。API系2つの
behaviorは`CachePolicy.CACHING_DISABLED`(結果整合性のあるレスポンスをCDNにキャッシュ
させない)。`/command-api/*`は`OriginRequestPolicy`で`Idempotency-Key`ヘッダーを明示的
にオリジンへ転送する(CloudFrontはデフォルトで任意ヘッダーを転送しないため)。

### 5. ローカル開発でもCORSを発生させない: Vite dev serverのプロキシがCloudFrontと同じ役割を担う

このリポジトリにはローカルで動くバックエンドが無く(CLAUDE.md参照)、`web-ui`の
`npm run dev`も実際にデプロイ済みの実AWS API(`aws cloudformation describe-stacks
--stack-name MonetaAccountPipelineStack`で取得)を叩く。Vite dev serverの
`server.proxy`(`vite.config.ts`)に、CloudFront Functionと同じ「prefixを剥がして
オリジンへ転送する」役割を持たせることで、フロントエンドのコード自体
(`src/api/client.ts`)は本番/開発どちらでも`/query-api/...`・`/command-api/...`という
同じ相対パスを叩くだけで完結する。実APIのURLは`.env.local`(gitignore対象)で指定し、
コードにハードコードしない。

結果として、**API Gateway側(`queryApi`/`commandApi`のVTL)にはCORS関連の変更を一切
加えていない。**

## 却下した代替案

- **API Gateway側でCORSを有効化する(通常のOPTIONSモックメソッド+
  `Access-Control-*`ヘッダーの追加)**: 技術的には可能だが、`queryApi`/`commandApi`は
  どちらもLambdaレスのVTL直接統合であり、[[0006-write-path-api-gateway-sqs-direct-integration]]
  で実際に3件のVTL実機バグ(クォート衝突・改行混入・エラーマスキング)を踏んだ経緯を
  踏まえると、CORSヘッダーをVTLのintegrationResponse側に追加する変更はバグの温床を
  増やす方向にしかならない。オリジンを1つに統合する方が、既存のVTL実装に一切手を
  入れずに済む。
- **単一の`/accounts/*` cache behavior**: 決定4に記載の通り、CloudFrontはHTTPメソッド
  で振り分けられないため、GET(照会)とPUT(Open)が衝突し成立しない。
- **見た目だけのログイン画面 / クライアント側の簡易ゲート**: 決定3参照。実質的な
  セキュリティ境界が無いことを隠す方向の変更であり、PoCとして公開する上で誤解を招く
  リスクの方が大きいと判断した。

## 今回のスコープ外として残す既知のギャップ

- `queryApi`/`commandApi`は引き続きそれぞれの`execute-api`ドメインから直接到達可能
  (CloudFront経由のみに制限していない)。実機検証([[0006-write-path-api-gateway-sqs-direct-integration]])
  で直接叩く手段を残しておく実用上の理由があり、PoCの規模でここを閉じる優先度は低いと
  判断し、当面許容する。
- ~~`web-ui/dist`の事前ビルドは`cdk deploy`に自動連携されていない~~ →
  解消済み。手動ステップに依存していたことが実際に事故を招いた(`dist`が古いまま
  デプロイされる、`infra`の`npm test`が`web-ui/dist`未生成のまま`CannotFindAsset`で
  落ちてCIが赤くなる、の両方を実際に踏んだ)ため、`infra/package.json`の
  `pretest`/`presynth`/`prediff`/`predeploy`/`predestroy`にそれぞれ`npm --prefix
  ../web-ui install && npm run build`(`build-web-ui`スクリプト)を紐付けた。npm標準の
  pre-hook機構(`posttest`/`postdeploy`のDockerキャッシュ掃除と同じ仕組み)を使うだけで
  済んだため、Rust Lambda群のようなDockerバンドリングの複雑さは今回も持ち込んでいない。

# moneta Web UI

`account-service`の書き込み/読み取りAPIを操作するSPA(React + TypeScript + Vite)。
設計判断の背景は`docs/adr/0007-web-ui-stack-and-hosting.md`を参照。

認証機構はない(スコープ境界、`docs/adr/0007`)。単一オペレーター向けの操作コンソールとして
扱う。

## ローカル開発

このリポジトリにはローカルで動くバックエンドがない(CLAUDE.md参照)ため、`npm run dev`は
実際にデプロイ済みの実AWS APIへVite dev serverのプロキシ経由でアクセスする。本番では
CloudFrontが同じ役割(パスprefixの書き換えによるオリジン統合、CORS回避)を担う——詳細は
`docs/adr/0007`。

1. 実APIのURLを取得する(スタックが再作成されるとURLが変わりうるため都度取得する):
   ```bash
   aws cloudformation describe-stacks --stack-name MonetaAccountPipelineStack \
     --query "Stacks[0].Outputs"
   ```
2. `.env.local.example`を`.env.local`にコピーし、`QueryApiUrl`/`CommandApiUrl`の値を
   それぞれ`VITE_QUERY_API_URL`/`VITE_COMMAND_API_URL`に設定する。
3. 依存関係をインストールして起動する:
   ```bash
   npm install
   npm run dev
   ```

フロントエンドのコード自体は`/query-api/...`・`/command-api/...`という相対パスしか叩かず、
環境ごとのURL分岐を持たない(`src/api/client.ts`)。

## ビルド

```bash
npm run build
```

`dist/`が生成される。`infra`側の`cdk deploy`は、この`dist/`をS3にアップロードする
`BucketDeployment`を含む(`infra/lib/account-pipeline-stack.ts`)ため、**`cdk deploy`前に
必ずこのビルドを実行しておくこと**。

## 型チェック・Lint

```bash
npx tsc -b --noEmit
npm run lint
```

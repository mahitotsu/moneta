# UI E2E テスト

`docs/e2e-scenarios.md`に記載したシナリオのうち、実際のブラウザでWeb UIを操作しないと
証明できない部分の自動化(`docs/adr/0014`)。`api-e2e/`が「デプロイ済みのAPIへの生HTTP
リクエスト」を検証するのに対し、こちらは「デプロイ済みのWeb UI(CloudFront配信のReact
SPA)を実際にヘッドレスChromiumで操作し、画面に正しい状態・ボタンが表示され、実際に
クリックが効くこと」を検証する。

## 前提

- `api-e2e/README.md`と同じ前提(`MonetaAccountPipelineStack`がap-northeast-1にデプロイ
  済みであること、そのスタックを呼び出せるAWS認証情報)。
- Playwright(Chromium、ヘッドレスのみ、`docs/adr/0014`)。`npm install`後、初回のみ
  `npx playwright install chromium`でブラウザバイナリを取得する。

## 実行方法

`api-e2e/README.md`と同じ順序・同じ注意点(必ず先にデプロイし直すこと)。

```bash
cd infra && npm run deploy   # 1. 最新のソースをデプロイする
cd ../ui-e2e && npm install  # 2. 初回のみ
npx playwright install chromium  # 2'. 初回のみ(ブラウザバイナリの取得)
npm test                     # 3. 今デプロイされている断面に対して検証する
```

`api-e2e/`と同様、対象は常にデプロイ済みのCloudFront URL(`WebUiUrl`スタック出力)のみ
——ローカルのvite devサーバーは対象にしない(`docs/adr/0014`決定1)。

## この仕組みが解決するギャップ、解決しないこと

`api-e2e/README.md`のシナリオ対応表は、H1-H3・A4/A5のUI固有部分について「このハーネスは
生HTTP呼び出しのみで、実際のWeb UI(ブラウザ)は駆動していない。ブラウザ自動化
(Playwright等)が別途必要」と明記していた。このディレクトリがその隙間を埋める。

- **口座開設・サインイン画面自体はブラウザで再現しない**(`docs/adr/0014`決定2)。
  `support/seed.ts`が生HTTPで口座を用意し、`support/session.ts`が
  `web-ui/src/customerSession.ts`のlocalStorageスキーマへ直接注入する
  (`BrowserContext.addInitScript`)。サインイン画面・口座一覧への追加操作自体は
  非機能なダミー(`docs/adr/0009`決定2)であり、`api-e2e/`・vitestコンポーネントテスト
  (`web-ui/src/components/*.test.tsx`)のどちらのカバー範囲にも新たに寄与しない。
- **検証するのはTransfer serviceの顧客向け画面(振替/振込/確認/取消/組戻し、
  `docs/adr/0012`決定6)に絞る**。既存のUI表示ロジックの主張(反映待ちの文言等)は
  `web-ui/src/components/*.test.tsx`(Vitest、モックAPI)が既にコンポーネント単体で
  検証しており、実AWS環境やブラウザ自動化を要さない。ここで重複して検証しない。

| シナリオ | ファイル |
|---|---|
| J1, J7 | `scenarios/transfer-furikae.spec.ts` |
| J5, J6 | `scenarios/transfer-furikomi.spec.ts`(確認して完了) |
| (J5派生) | `scenarios/transfer-furikomi.spec.ts`(確認前に取消してcancelled) |
| J9 | `scenarios/transfer-recall.spec.ts` |

J2/J3/J4/J8/J10(ドメイン却下・入力検証系)はUI固有の主張を含まず、`api-e2e/`が既に
HTTPレベルで検証済みのため、ここでは繰り返さない。

## 実装上の注意

- `support/stackOutputs.ts`・`support/ownerIndex.ts`は`api-e2e/`の同名ファイルと役割が
  重複するが、あえて別々に持つ(`api-e2e/`・`web-ui/`が独立したTSプロジェクトである理由と
  同じ、`docs/adr/0014`)。`support/seed.ts`は`api-e2e/support/testAccount.ts`の
  `CommandApi`/`QueryApi`抽象を丸ごと複製せず、口座開設+active待ちの2関数だけを
  自己完結で持つ(振込・確認・取消しかこのハーネスは呼ばないため)。
- `support/ui.ts`はweb-uiの実際の表示文言(ボタンラベル・ラベルテキスト)でセレクタを
  組み立てる。test-id属性は現状web-ui側に無いため、実際の顧客が読むのと同じ文言を頼りに
  する——文言変更がこのテストを壊すのは意図通りで、それこそがこのハーネスが検出すべき
  ドリフトである。
- `force-ipv4.cjs`は`api-e2e/`と同じワークアラウンド(このdevサンドボックスのDNS
  リゾルバがAAAAクエリでハングする問題、`infra/README.md`参照)。Node側の`fetch`
  (`support/seed.ts`・AWS SDK)には必要だが、実際に確認したところヘッドレスChromium
  自身のブラウザ内ネットワーキング(`page.goto`等)は同じ問題を踏まなかった
  ——ブラウザ側に同種の回避策を追加する必要はなかった。
- `TransferDetailScreen.tsx`の取消・組戻しボタンは`window.confirm`の背後にある
  (`docs/adr/0012決定6`)。Playwrightは既定でネイティブダイアログを自動的に閉じる
  (`dialog.dismiss()`相当)ため、`support/ui.ts`の`clickCancelTransfer`/`clickRecall`は
  クリック前に`page.once("dialog", ...)`でハンドラを組んでおく。

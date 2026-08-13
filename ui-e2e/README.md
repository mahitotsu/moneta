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

`api-e2e/README.md`のシナリオ対応表は、FC9・FC2/FC3のUI固有部分について「このハーネスは
生HTTP呼び出しのみで、実際のWeb UI(ブラウザ)は駆動していない。ブラウザ自動化
(Playwright等)が別途必要」と明記していた。このディレクトリがその隙間を埋める。

- **口座開設・サインイン画面自体は原則ブラウザで再現しない**(`docs/adr/0014`決定2の方針を
  `docs/adr/0016`後も維持)。`support/seed.ts`が生HTTPで口座を用意し、`support/auth.ts`が
  実際のCognitoユーザーをサインアップ+サインインしてトークンを取得、`support/session.ts`が
  `web-ui/src/auth.ts`のlocalStorageスキーマ(`moneta.auth.*`)へそのトークンを直接注入する
  (`BrowserContext.addInitScript`)。**唯一の例外が`scenarios/auth.spec.ts`**——サインアップ/
  サインイン画面自体の実DOM配線を検証するのがこのシナリオの主題なので、ここだけは
  `support/session.ts`を使わず実際にフォームへ入力してボタンを押す。口座はもはや
  「開設後に一覧へ手で追加する」ものではない(`docs/adr/0016`決定4がその手入力機能自体を
  廃止した)ので、`support/seed.ts`で開いた口座は同じ識別子(idToken)でサインインしている限り
  自動的に一覧へ現れる。
- **検証するのはTransfer serviceの顧客向け画面(振替/振込/確認/取消/組戻し、
  `docs/adr/0012`決定6)に絞る**。既存のUI表示ロジックの主張(反映待ちの文言等)は
  `web-ui/src/components/*.test.tsx`(Vitest、モックAPI)が既にコンポーネント単体で
  検証しており、実AWS環境やブラウザ自動化を要さない。ここで重複して検証しない。

| シナリオ(新ID、[production-readiness-matrix.md](../docs/production-readiness-matrix.md)) | ファイル |
|---|---|
| FC10(旧J1/J7) | `scenarios/transfer-furikae.spec.ts` |
| FC11(旧J5/J6) | `scenarios/transfer-furikomi.spec.ts`(確認して完了) |
| FC11派生 | `scenarios/transfer-furikomi.spec.ts`(確認前に取消してcancelled) |
| FC12(旧J9) | `scenarios/transfer-recall.spec.ts` |
| FC15(2026-08-12追加) | `scenarios/transfer-furikae.spec.ts`(振替完了画面に「組戻す」ボタンが描画されないことを確認) |
| FC13(2026-08-12追加) | `scenarios/transfer-furikae.spec.ts`(非正の金額を送信しても反映待ち画面のまま留まることを確認) |
| FC17(2026-08-13追加、docs/adr/0015) | `scenarios/transfer-other-bank.spec.ts`(振込(他行あて)は選んでも案内文のみで、実際のAPI呼び出しが発生しないことを確認) |
| FC18(2026-08-14追加、docs/adr/0016) | `scenarios/auth.spec.ts`(実際のサインアップ/ログイン画面を操作し、新規登録直後に自動サインイン、開設した口座が手入力なしに一覧へ現れること、誤った認証情報ではCognitoの内部例外名を出さず業務文言のみでログイン失敗すること、を確認) |

旧J2/J3/J4/J8/J10相当(ドメイン却下・入力検証系)はUI固有の主張を含まず、`api-e2e/`が既に
HTTPレベルで検証済みのため、ここでは繰り返さない。

## 実装上の注意

- `support/stackOutputs.ts`・`support/ownerIndex.ts`・`support/auth.ts`は`api-e2e/`の
  同名ファイルと役割が重複するが、あえて別々に持つ(`api-e2e/`・`web-ui/`が独立したTS
  プロジェクトである理由と同じ、`docs/adr/0014`)。`support/auth.ts`は`api-e2e/support/auth.ts`
  と違い、idToken・subだけでなくaccessToken/refreshTokenも返す——`web-ui/src/auth.ts`が
  この3つ全てをlocalStorageに保持するため、`support/session.ts`が実ブラウザへ「サインイン
  済み」を再現するには3つとも要る。`support/seed.ts`は`api-e2e/support/testAccount.ts`の
  `CommandApi`/`QueryApi`抽象を丸ごと複製せず、口座開設+active待ち+
  (`docs/adr/0016`決定4の)`CustomerAccountsTable`反映待ちの1関数(`openFreshAccount`)だけを
  自己完結で持つ(振込・確認・取消しかこのハーネスは呼ばないため)。AccountCommandApi/
  AccountQueryApi/AccountNumberQueryApiは全てCognito認証必須になった(`docs/adr/0016`決定2)
  ため、`support/seed.ts`・`support/accountNumber.ts`の生HTTP呼び出しは全て呼び出し元から
  受け取ったidTokenを`Authorization`ヘッダーに付与する。
- **Cognitoの使い捨てユーザーのteardown(2026-08-14追加)**: `support/auth.ts`の
  `signUpAndSignIn`が呼ばれるたびにセルフサインアップしたユーザーが片付かずに残ると、
  `npm test`を回すたびにUser Poolへユーザーが積み上がる(発覚時点で60件超)。
  `playwright.config.ts`は`fullyParallel: true`なので、ファイル単位の`afterAll`相当では
  同じファイルのテストが別ワーカーへ分散され得て信頼できない——`support/fixtures.ts`が
  Playwrightの`test`をworker-scoped・autoなフィクスチャ(`cognitoCleanup`)で拡張し、
  ワーカー終了時に必ず1回`cleanupSignedUpUsers`(セルフサービスの`DeleteUser`、追加のIAM
  権限不要)を呼ぶ。各specファイルは`@playwright/test`ではなく`../support/fixtures`から
  `test`/`expect`をimportするだけでよい。`scenarios/auth.spec.ts`だけは例外——実際の
  サインアップ画面を通してユーザーを作るため`signUpAndSignIn`を経由せず、
  `registerAccessTokenForCleanup`でブラウザのlocalStorageから取り出したaccessTokenを
  明示的に同じ待ち行列へ加えている。
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

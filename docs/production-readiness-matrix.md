# 実用性のめどマトリクス(Production-Readiness Matrix)

## 位置づけ

`docs/e2e-scenarios.md`は**ボトムアップ**(ドメインモデルの列挙・各ADRの決定を1つずつ拾う)で作られたシナリオ台帳だった。この方法には構造的な限界がある: **コードやADRに一度も書かれていない領域は、原理的に見つけられない**(2026-08-10のセッションで、資金保存則の検証・業務メトリクス・流量特性の3領域がこの方法では一度も浮上しなかったことで実証済み)。

このマトリクスは**トップダウン**(このコードベースの外にある3つの標準的な分類軸を先に当てて、埋まっているセルと空白のセルを機械的に洗い出す)方式を取る。空白のセル(対応するADRの決定すら存在しない)自体が「気づいていなかった領域」の証拠になり、洗い出しの網羅性が特定の個人の思いつきに依存しなくなる。

**将来的な位置づけ**: `docs/e2e-scenarios.md`とそれに基づく`api-e2e`/`ui-e2e`のシナリオ体系は、このマトリクスに基づく体系に置き換える(廃止する)方針。本ドキュメントはその移行の第一段階(現状の可視化)であり、移行計画そのものは末尾の「次のステップ」で別途合意を得る。

**関連ドキュメント**: ⓪機能的正しさ層自体もボトムアップの限界を持つため、[decision-tables.md](decision-tables.md)が`AccountState`/`SagaState`を状態遷移表・ディシジョンテーブルとして機械的に再列挙し、この層特有の空白を洗い出している。**さらに、決定表もまた「既にコードとして存在するものの中の空白」しか見つけられないボトムアップな手法である**(2026-08-10のセッションで指摘された通り)。この限界に対応するため、④(コアバンキング機能領域)を追加し、コードを一切読まずに「一般的なコアバンキングが備える機能領域」を先に列挙し、それが`docs/adr/`に言及されているかどうかを外形的に確認する形を取った。

## 分類軸の選定根拠

| 層 | 採用する分類 | 採用理由 |
|---|---|---|
| ④ コアバンキング機能領域 | 口座ライフサイクル・資金移動・金利・手数料・当座貸越・複数名義・多通貨・明細・限度額・KYC・認証・苦情処理・休眠口座・規制報告・通知・マルチチャネル・元帳整合性、等 | 一般的なコアバンキングシステムが備える機能領域の標準的な分類。**論理的には⓪より前にあるべき層**(機能がコードとして存在しなければ⓪の検証対象自体がない)で、このコードベースを一切読まずに列挙できる唯一の⓪系統の軸 |
| ⓪ 機能的正しさ | 各コマンド/APIの正常系・異常系(ドメインエラー・構造検証) | AWS Well-Architectedの6本柱は意図的に非機能面だけを扱う設計であり、②③も横断的リスクを扱う。「Withdrawが残高不足を正しく拒否するか」のような基本機能の正しさはどの層にも属さないため、旧`docs/e2e-scenarios.md`のA/B/G/H(とJの正常系部分)の受け皿として独立に設ける。**この層は空白探しが目的ではなく、既存の機能検証を新ID体系へ引き継ぐためのもの**で、判定はほぼ🟢になる想定 |
| ① 一般的な品質特性 | AWS Well-Architected Framework の6本柱 | このシステムはAWSサーバーレス構成そのものの技術検証であり、対象が完全に一致する |
| ② イベント駆動アーキテクチャ固有のリスク | at-least-once/重複、順序保証、毒メッセージ/DLQ、バックプレッシャー/スケーリング、スキーマ互換性、サガの補償失敗モード、結果整合性の窓 | Enterprise Integration Patterns・Sagaパターンで確立された、EDA一般に共通する定番リスク分類 |
| ③ 銀行元帳(ledger)固有のリスク | 資金保存則、監査ログの完全性、非否認性、限度額/不正検知、突合(reconciliation) | ドメインが口座管理である以上、実装によらず必ず当てはまる業務要件 |

## 凡例

- 🟢 **実装・検証済み**: ADRの決定と、それを検証する自動テストの両方が存在する
- 🟡 **決定はあるが未検証**、または**意図的にスコープ外と明記**されている(どちらかを明記する)
- 🔴 **ADRの決定すら存在しない**(空白領域。ボトムアップの方法では発見できなかった箇所)
- ⚪ この記事の主張(イベント駆動アーキテクチャの技術妥当性)の範囲外と判断(理由を併記)
- 🔵 **将来の検証候補**: 現時点で未着手だが、この記事の主張(イベント駆動アーキテクチャの
  疎結合性)を実証する価値があると判断し、バックログとして記録する項目(実装や自動テストの
  着手はまだ合意していない)
- 🚧 **ブロック中**: 着手するには、障害注入基盤・負荷生成ツール・追加のADR決定のいずれかが
  前提条件になっており、この技術検証の範囲内(単体テスト・CDK・型チェックで完結する作業)
  では完了できない項目。行ごとに具体的な前提条件を明記する

各行に根拠(ファイル:行、ADR番号、または「未確認」)を付す。「未確認」は今回のセッションで深掘りできなかった項目で、要追加調査。

---

## ⓪ 機能的正しさ(Functional Correctness)

**このセクションはボトムアップ(旧シナリオの手読み)で作られたため、①②③と同じ限界を持っていた。
[decision-tables.md](decision-tables.md)で`AccountState`/`SagaState`を状態遷移表・ディシジョン
テーブルとして機械的に再列挙し、5件の新たな穴(FC3の記述訂正を含む)を発見済み。以下の判定は
その結果を反映済み。**

| # | 項目 | 判定 | 根拠(旧ID) |
|---|---|---|---|
| FC1 | 口座開設: 正常系・異常系(重複ID・負の初期残高・精度超過) | 🟢 | 旧A1/B5、`open-account.e2e.test.ts` |
| FC2 | 入金(Deposit): 正常系・異常系(負値・凍結中・解約後) | 🟢 | 旧A2/A4/B2/B3、`deposit-withdraw.e2e.test.ts`・`domain-errors-*.e2e.test.ts` |
| FC3 | 出金(Withdraw): 正常系・異常系(残高不足・凍結中・解約後・負/ゼロ額) | 🟢(2026-08-10、[decision-tables.md](decision-tables.md)発見1を是正。単体テストは`cargo test -p account-domain`で実行・合格を確認済み。E2E側はコード追加済みだが、ライブスタックに対して実行・合格確認済み(2026-08-12、api-e2e npm test 22スイート43テスト全合格)) | 旧A3/A5/B1/B2/B3、同上 |
| FC4 | 凍結/凍結解除: 正常系・異常系(二重凍結・Active時のUnfreeze) | 🟢 | 旧A6/A7/B6/B7、`domain-errors-frozen-account.e2e.test.ts`・`unfreeze-lifecycle.e2e.test.ts` |
| FC5 | 解約: 正常系・異常系(解約後の全操作拒否・Frozenからの直接解約) | 🟢(2026-08-10、[decision-tables.md](decision-tables.md)発見2を是正。単体テスト`frozen_account_can_be_closed_directly_without_unfreezing_first`実行・合格確認済み、E2Eはライブスタックに対して実行・合格確認済み、2026-08-12) | 旧A8/B3、`domain-errors-closed-account.e2e.test.ts`・`domain-errors-frozen-account.e2e.test.ts` |
| FC6 | 取引履歴: 新しい順・件数上限 | 🟢 | 旧A9、`transaction-history.e2e.test.ts` |
| FC7 | APIGW構造検証: 型/必須項目/enum/金額パターン | 🟡(精度境界`10.123`のような桁数超過ケースは未検証、[decision-tables.md](decision-tables.md)発見3で再確認) | 旧G1-G3、`input-validation.e2e.test.ts` |
| FC14 | サガの二重操作拒否(`Confirm`/`Cancel`をPendingConfirmation以外に送る) | 🟢(2026-08-10、[decision-tables.md](decision-tables.md)発見4を是正。E2E追加、ライブスタックに対して実行・合格確認済み、2026-08-12) | `transfer-furikomi.e2e.test.ts` |
| FC15 | 組戻し(Recall)の業務境界(振替/組戻し自体への誤ったRecall要求) | 🟢(2026-08-10、[decision-tables.md](decision-tables.md)発見5を是正。API・UIとも実行・合格確認済み、2026-08-12。TransferDetailScreen.tsxが`kind===furikomi`でのみ「組戻す」ボタンを描画するというUI固有の主張は、api-e2eのAPI直叩きテストだけでは検証できておらず、`ui-e2e/scenarios/transfer-furikae.spec.ts`に追加) | `transfer-recall.e2e.test.ts`・`transfer-furikae.spec.ts` |
| FC8 | 既知のギャップ: 不正な形式の`accountId` | 🟢(意図的な既知のギャップとして固定) | 旧G4、`known-gap-malformed-account-id.e2e.test.ts` |
| FC9 | 顧客/外部チャネル画面のUI分離(ボタン非表示・サインイン要否) | 🟡(H1-H3、api-e2e/README.mdが自己申告している既知の未実装) | 旧H1-H3、未実装(ブラウザ自動化なし) |
| FC10 | 送金(振替)の基本正しさ: 同一名義・確認不要・即時開始 | 🟢 | 旧J1/J2/J4/J7、`transfer-furikae.e2e.test.ts` |
| FC11 | 送金(振込)の基本正しさ: 名義不一致・確認必須・上限額 | 🟢 | 旧J5/J6/J8、`transfer-furikomi.e2e.test.ts` |
| FC12 | 組戻し(recall)の基本正しさ: 時間窓・残高不足 | 🟢 | 旧J9/J10、`transfer-recall.e2e.test.ts` |
| FC13 | transfer-serviceの`start`入力検証: 非正の金額・精度超過 | 🟡(2026-08-10。`NonPositiveAmount`はAPI・UIとも実行・合格確認済み、2026-08-12。TransferForm.tsxは金額を一切クライアント側検証しておらず、実際に顧客が"0"を送信できる操作なのでUI固有の検証価値がある——ただし当初想定した「エラー表示」ではなく、Startが202を返しサガが作られないため「反映待ち」画面のまま留まる、というADR-0012決定6の既存トレードオフの延長だと判明。`transfer-furikae.spec.ts`に追加。`InvalidAmountPrecision`はAPIGWの構造検証で先に4xx拒否されるためE2E到達不能——FC7と同種の理由、単体テストのみで妥当) | `saga.rs`単体テスト、`transfer-furikae.e2e.test.ts`・`transfer-furikae.spec.ts` |

---

## ① AWS Well-Architected Framework

### 信頼性(Reliability)

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| R1 | 同一集約への並行書き込みでの整合性(FIFO直列化) | 🟢 | [ADR-0002](adr/0002-sqs-message-lifecycle-and-error-classification.md)、`api-e2e/scenarios/concurrency.e2e.test.ts`(D1) |
| R2 | DynamoDB OCC競合からのLambda内リトライでの回復 | 🟢(2026-08-10。[ADR-0002](adr/0002-sqs-message-lifecycle-and-error-classification.md)に具体的トリガーを追記した上で、`aws-smithy-mocks`によりDynamoDBクライアントをHTTPトランスポート層でモック化した単体テスト`optimistic_lock_conflict_is_retried_in_lambda_and_eventually_succeeds`を実装・`cargo test -p account-service`で合格確認済み) | [handler.rs](../crates/account-service/src/handler.rs)。黒箱の並行HTTPリクエストでは競合を再現できない(AWSの「1グループ1同時実行」保証)ため、単体テストが決定論的検証の唯一の現実的手段だった |
| R3 | SQSレベル再配信からの回復(2段階リトライの2段目、成功パス) | 🟡🚧**ブロック中**(決定はあるが未検証) | [ADR-0002決定6](adr/0002-sqs-message-lifecycle-and-error-classification.md#L176-L214)。`group-independence.e2e.test.ts`(E1)は失敗して終わる経路(DLQ行き)のみ検証、回復して成功する経路は未検証。**着手には、Lambda内3回のリトライを意図的に使い切らせてSQSへ再配信させる仕組みが要る**(例: DynamoDBの書き込みキャパシティを一時的に絞って持続的なスロットリングを起こす、またはAWS Fault Injection Simulator)。R2で使ったHTTPモックは`account-service`単体の話であり、SQSの再配信自体は実AWS環境が要るため同じ手法は使えない |
| R4 | 持続的インフラ障害でのDLQ到達 | 🟡(P2・手動確認のみと明記) | `docs/e2e-scenarios.md` I1 |
| R5 | メッセージグループの独立性(無関係な集約への影響なし) | 🟢 | `group-independence.e2e.test.ts`(E1) |
| R6 | サガの補償(送金失敗時の資金保全) | 🟢 | [ADR-0010](adr/0010-transfer-service-saga.md)、`transfer-*.e2e.test.ts`(J1-J10) |
| R7 | サガの補償自体が却下され続けるケース(`Compensating`滞留) | 🟢(2026-08-21。ADR-0028のウォッチドッグが自己修復——条件解消後は再送で自動回復、再送上限を超えても銀行所有の仮受金口座へ確定的に退避し「多分大丈夫」を残さない。両経路とも`saga-self-healing.e2e.test.ts`でライブスタックに対し合格確認済み) | [ADR-0028](adr/0028-saga-self-healing-watchdog.md)、`saga-self-healing.e2e.test.ts` |
| R8 | 複数のイベント駆動な発行元(直接顧客操作 と transfer-serviceのサガ)が同一集約を同時に取り合う安全性 | 🟢(2026-08-10、`concurrency-cross-producer.e2e.test.ts`追加、ライブスタックに対して実行・合格確認済み、2026-08-12) | [commands.rs:35](../crates/transfer-service/src/commands.rs#L35)で同一`MessageGroupId`空間に収束する設計であることを実証するテスト |
| R9 | DynamoDBスロットリング・接続断からの回復 | 🔴🚧**ブロック中** | ADRは「インフラ起因の失敗」として抽象的に分類するのみで、スロットリング固有の検証(バックオフの妥当性等)への言及なし。**「回復」自体(SQSの再配信をまたぐ)はR3と同じ障害注入基盤が前提条件**——スロットリングはLambda1回の呼び出し内では回復せず、`classify_transact_error`が`ApplyCommandError::Infra`として即座に呼び出し元へ伝播し、SQSの再配信に委ねる設計だから(R2のOptimisticLockConflictとは違うコードパス)。ただし「スロットリングが正しくInfraとして分類・伝播される」こと自体は、R2と同じ`aws-smithy-mocks`パターンで`ProvisionedThroughputExceededException`を返させれば単体テストで決定論的に検証できる(次に着手するならここが低コストな部分検証) |

### 運用上の優秀性(Operational Excellence)

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| O1 | DLQ滞留・エージングへのCloudWatchアラーム | 🟢(2026-08-10実装。両DLQ(account/transfer)に`ApproximateNumberOfMessagesVisible`/`ApproximateAgeOfOldestMessage`アラームを追加し、CDK synthテストで検証。`npm test`実行・25件全合格確認済み) | `infra/lib/account-pipeline-stack.ts`の`addDlqAlarms` |
| O2 | ビジネスレベルの可観測性(リトライ発生数、サガ滞留数等のカスタムメトリクス) | 🟡(2026-08-10、リトライ分岐へのログ追加のみ実装・コンパイル/clippy確認済み。カスタムメトリクス化は引き続き未着手) | [handler.rs](../crates/account-service/src/handler.rs)の`tracing::warn!` |
| O3 | デプロイの安全性(synthテストによる検証) | 🟢 | `infra/test/`、CI(`ci.yml`) |
| O4 | IAM境界の回帰防止 | 🟢 | `infra/test/account-pipeline-stack.test.ts:206`(query projectorがaccount-service自身のテーブルにアクセスできないことを検証) |
| O5 | 実運用トラブル発生時の切り分け手順(runbook) | ⚪ | CLAUDE.mdが明記する通り、組織的リアリズム(運用プロセス)はこのPoCの意図的なスコープ外 |

### セキュリティ(Security)

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| S1 | 認証・認可・セッション管理 | 🟢(2026-08-20、[[0027-item-level-read-authorization]]でitem単位の読み取り認可も解消) | [ADR-0016](adr/0016-cognito-authentication.md): Amazon Cognito User Poolによる実サインアップ/サインイン、顧客向けエンドポイント(`Deposit`/`Withdraw`を除く)全てに`CognitoUserPoolsAuthorizer`、`owner_id`はJWTの`sub`が正(自己申告を無視)、`Freeze`/`Unfreeze`/`Close`は`requested_by`と現在の`owner_id`の一致を検証(`DomainError::NotOwner`)。**旧残存ギャップ(ADR-0016トレードオフ節が当時記録、[ADR-0027](adr/0027-item-level-read-authorization.md)で解消)**: 認証済みの別人が他人の`accountId`を直接指定すれば`GET /accounts/{id}`は閲覧できてしまっていた——書き込み系は認可済みだが読み取り系は認証止まり、という非対称。同じ非対称は`GET /transfers/{transferId}`(`TransferQueryApi`)にもあり、2026-08-18、[[0025-points-balance-query-api-and-header-display]]の動作確認中に無関係な使い捨て識別子から他人の送金を実際に閲覧できることを直接確認していた。ADR-0027は、AccountViewTable/AccountHistoryTable/TransferStatusViewTableの各アイテムに名義(`ownerId`/`fromOwnerId`/`toOwnerId`)を持たせ、GetItem/QueryのレスポンスVTLで`$context.authorizer.claims.sub`と比較する形で、Lambdaを増やさずに解消した。`GET /customers/me/points`(`PointsQueryApi`、決定1)はJWTの`sub`から`ownerId`を導出する形(`accountId`のようなクライアント指定のIDを取らない)のため、この種のitem単位の認可漏れは元から構造的に発生しない |
| S2 | IAM最小権限(TransactWriteItemsの個別アクション要求等) | 🟢 | [ADR-0013決定5](adr/0013-migrate-account-service-off-aurora-dsql.md)、`infra/test/`のIAMアサーション |
| S3 | 入力の構造的検証(型・必須項目・パターン) | 🟢 | ADR-0006決定4/5、`input-validation.e2e.test.ts`(G1-G3) |
| S4 | 敵対的input耐性(異常に大きい金額・長い文字列・大量リクエストでのふるまい) | 🔴🚧**ブロック中** | ADR・テストともに言及なし。**テスト以前に「どこまでをサポートする振る舞いとして定義するか」の設計判断(ADR)が先に必要**(例: 金額の桁数上限、APIGWレベルのリクエストサイズ制限、レート制限の要否)。この判断なしにテストを書いても、何を「正しい」とみなすかの基準がない。[ADR-0016](adr/0016-cognito-authentication.md)導入により、口座番号(7桁)の匿名総当たりは認証必須化で不可能になったが(S1解消の副産物)、**認証済みユーザーによる大量リクエストへのレート制限は引き続き無防備**——この項目自体の判定はブロック中のまま変わらない |
| S5 | 保存データの暗号化 | ⚪ | DynamoDB既定のAWS管理暗号化に依存。アプリケーション側の設計判断が存在しない領域 |
| S6 | シークレット管理 | ⚪ | IAMロールベースの認可のみで、APIキー等のシークレット自体が設計上存在しない |

### パフォーマンス効率(Performance Efficiency)

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| P1 | 結果整合性の遅延境界(単発操作) | 🟢 | [ADR-0004](adr/0004-query-service-event-driven-projection.md)、`eventual-consistency.e2e.test.ts`(F1) |
| P2 | 実運用に近い流量(多数口座が同時に取引)での挙動 | 🔴🚧**ブロック中** | 全ての並行性テストが「1口座に対し2〜10件」のみ。多数の異なる`MessageGroupId`が同時に走る状況(Lambdaの同時実行数上限、スケーリング特性)は一度も検証されていない。**負荷生成ツール(k6・Artillery等)を新たに導入し、デプロイ済みの実環境に対して数百口座・数千リクエスト規模で駆動する仕組みが要る**——`api-e2e`の既存のJestベースの仕組みでは非現実的な規模。I1(持続的インフラ障害)と同じ「手動/オンデマンド、実環境限定」という位置づけになる見込み |
| P3 | 結果整合性の遅延境界が流量に応じてどう劣化するか | 🔴🚧**ブロック中** | P1は無負荷状態のみ。負荷下での遅延特性への言及なし。**P2と同じ負荷生成基盤に依存**(P2を実施した際に同時に計測できる) |

### コスト最適化・持続可能性

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| C1 | コスト最適化 | ⚪ | この記事の主張(イベント駆動アーキテクチャの技術的妥当性)と無関係。PoCとして意図的に対象外 |
| C2 | 持続可能性 | ⚪ | 同上 |

---

## ② イベント駆動アーキテクチャ固有のリスク

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| E1 | at-least-once配信での重複排除(冪等性) | 🟢 | ADR-0002決定4、`idempotency.e2e.test.ts`(C1/C2) |
| E2 | メッセージ順序保証(`SequenceNumber`明示ソート) | 🟡🚧**ブロック中**(決定はあるが、順序**逆転**を意図的に作っての検証はない) | [ADR-0002決定5](adr/0002-sqs-message-lifecycle-and-error-classification.md#L151-L174)。D1/D2は「壊れないこと」は見るが、「送信順と異なる到着順でも正しくソートされる」ことを狙って作ったテストではない。**SQSは到着順を外部から制御する手段を公式には提供しないため、E2Eで意図的に順序を乱すのは困難**。`grouping.rs`(`SequenceNumber`でのソート処理そのもの)は既に単体テスト済み(`messages_arriving_out_of_order_are_sorted_by_sequence_number_within_group`)であり、この単体テストの入力を「実際にSQSが返しうる歯抜け・逆転パターン」がどこまで網羅しているかをレビューする方が、E2Eでの再現を試みるより現実的 |
| E3 | 毒メッセージ/DLQ(恒久的に失敗するメッセージの隔離) | 🟢(終端到達のみ) | `known-gap-malformed-account-id.e2e.test.ts`(G4)、`group-independence.e2e.test.ts`(E1) |
| E4 | バックプレッシャー・スケーリング特性 | 🔴 | P2と同一問題。EDAの根幹的リスクだが未着手 |
| E5 | イベントスキーマの後方/前方互換性 | 🟢(型システムによる保証、実行時テストではない) | `account_domain::Event`をproducer/consumerで共有するモノレポ構成のため、新バリアント追加は全一致箇所でコンパイルエラーになる(CLAUDE.mdの「ワイルドカード禁止」規約)。ただし本物の複数言語・複数リポジトリ環境でのスキーマ進化(consumer側だけ古いバージョンが残る等)は検証対象外 |
| E6 | サガの補償失敗モード全般 | 🟢 | R6/R7と同一(重複整理) |
| E7 | 結果整合性の窓(顧客体験としての扱い) | 🟢 | `eventual-consistency.e2e.test.ts`(F1)、`AccountView.test.tsx`(F3) |

---

## ③ 銀行元帳(ledger)固有のリスク

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| L1 | 資金保存則(システム全体で合計金額が保存される) | 🟢(2026-08-10、`fast-check`を導入し`conservation-property.e2e.test.ts`としてプロパティベーステストを実装。ライブスタックに対して実行・合格確認済み、2026-08-12、numRuns=5全通過) | 同一名義口座間の振替が閉じた系の合計金額を変えないことをランダムな操作列で検証 |
| L2 | 監査ログ(`account_events`アウトボックス)の完全性(全状態変化が漏れなく記録される) | 🟢(2026-08-10、コード読解により構造的に保証済みと判明。テスト追加は不要と判断) | [persistence.rs:387-408](../crates/account-service/src/persistence.rs#L387-L408)の`apply_command`は、`event_put`を`Ok`/`Err`どちらの結果でも無条件で`items`に積み、`processed_message_put`・`account_write`(または`account_condition_check`)と**1回のTransactWriteItemsで原子的にコミット**する。状態変化とイベント記録が分離した書き込みになることが構造的にありえない設計 |
| L3 | 監査ログの改ざん不可能性(追記専用性) | 🟢(2026-08-10実装・実行確認済み) | **実装時に本物の過剰権限を発見・修正**: `accountEventsTable.grantWriteData(fn)`はコードコメントが「PutItemのみ」と謳っていたのに、実際にはUpdateItem/DeleteItem/BatchWriteItemも付与していた。`dynamodb:PutItem`のみの明示的な`grant`に置き換え、CDK synthテストで検証。`npm test`実行・25件全合格確認済み |
| L4 | 非否認性 | 🟡(S1解消により意味を持つようになったが不完全) | [ADR-0016](adr/0016-cognito-authentication.md)導入後、`Freeze`/`Unfreeze`/`Close`は認証済みJWTの`sub`と口座の`owner_id`が一致した場合のみ許可されるため、「誰が実行できたか」は暗黙に絞り込める。ただし各`Event`(`Frozen`/`Unfrozen`/`Closed`)自体は実行者の識別子を持たず、監査ログ上は口座の`owner_id`(`Opened`イベント由来)からの推論に留まる——暗号署名等の強い非否認性(実行者ごとの改ざん不可能な証跡)はない |
| L5 | 限度額・不正検知 | 🟡(限度額は実装・検証済み、不正検知はデータ表現のみ) | 限度額: [ADR-0011決定4](adr/0011-furikae-furikomi-distinction.md)、`transfer-furikomi.e2e.test.ts`(J8)。不正検知: `FreezeReason::SuspectedFraud`はデータとして表現されるのみで、検知エンジン自体は実装対象外(意図的) |
| L6 | 突合(reconciliation): 書き込み系(account-service)と読み取り系(Query service)の整合 | 🟡(個別口座単位でのみ、バッチ横断の突合はなし) | F1/F2が個々の口座単位の収束は見ているが、「全口座を横断して両ストアが完全に一致する」ことをまとめて確認する仕組みはない |

---

## ④ コアバンキング機能領域の網羅性(Domain Feature Coverage)

**位置づけ**: ⓪(機能的正しさ)・[decision-tables.md](decision-tables.md)は「既に存在するコードの
中の未検証セル」しか見つけられない、精緻化されたボトムアップ手法である(2026-08-10のセッションで
指摘された通り)。**論理的には④が⓪より先にあるべき層**——機能がコードとして一行も存在しなければ、
決定表を作る対象自体がない。①②③と同じく、このコードベースを一切読まずに存在する外部の物差し
(一般的なコアバンキングの標準的な機能領域)を先に立て、`docs/adr/`全体をキーワード検索する形で
「言及の有無」を機械的に確認した(2026-08-10)。

| # | 機能領域 | 判定 | 根拠 |
|---|---|---|---|
| D1 | 口座ライフサイクル(開設/凍結/凍結解除/解約) | 🟢 | ⓪FC1/FC4/FC5 |
| D2 | 資金移動: 単一口座(入出金) | 🟢 | ⓪FC2/FC3 |
| D3 | 資金移動: 口座間(振替・振込・組戻し) | 🟢 | ⓪FC10-FC12・FC16、[[0010-transfer-service-saga]]/[[0011-furikae-furikomi-distinction]]/
[[0015-friendly-account-numbers-and-branch-and-other-bank-placeholder]](人間可読な口座番号
(支店+7桁)からの宛先解決を追加、2026-08-13) |
| D4 | 資金移動: 対外(他行宛て振込・外部決済ネットワーク接続) | 🟡 | 「他行からの**入金**」はADR-0009が外部チャネルの`Deposit`として明示的にモデル化しているが、
「他行への**出金**」(このシステム外の口座への送金)は一度も言及がない。技術検証としてはSaga
パターンの本質(補償・確認要否)は変わらないと想定されるが、明記はされていない。振込の導線上に
自行/他行の分岐(⓪FC17)と非機能なプレースホルダは追加した([[0015-friendly-account-numbers-and-branch-and-other-bank-placeholder]]決定7、2026-08-13)が、対外接続の実装自体は含まない
——この判定を変える意思決定ではない |
| D5 | 定期振込・自動引落(standing order) | 🔵 将来の検証候補 | ADR全体で0件。ただしスケジュール駆動×既存コマンドキュー発行という、transfer-serviceの統合パターンをそのまま複製できる形(2026-08-10、下記「将来の検証候補」参照) |
| D6 | 金利計算(普通/定期預金の利息) | 🔵 将来の検証候補 | 同上、0件。Query serviceの読み取りモデル参照×Deposit発行という最小構成で検証できる |
| D7 | 手数料・課金(振込手数料・口座維持手数料) | 🟢(振込手数料のみ。口座維持手数料は0件のまま) | [[0024-rewards-service-fee-and-points]]。振込(furikomi)に固定額の手数料を課し、`fee-service`/`points-service`という2つの新設サービスが原資確保(現金/ポイントの按分)・徴収時失敗時の返却を担う——`account-service`/`query-service`は無改変。`api-e2e`の`scenarios/transfer-fee-and-points.e2e.test.ts`で付与・充当・返却の3経路とも実デプロイに対して検証済み(2026-08-18)。当初の見立て通り「イベント購読×補償サガという既存パターンに最も近い」形で実現できた。口座維持手数料(月額固定費等)は今回のスコープ外のまま |
| D8 | 当座貸越・信用供与 | 🔴 | 同上、0件。`Withdraw`は常に`amount <= balance`が絶対条件で、信用枠という概念自体が
`account.rs`のどこにもない |
| D9 | 複数名義・代理人アクセス(共同口座) | 🔴 | 同上、0件。`owner_id`は単一の文字列で、[[0011]]は振替/振込の判定にのみ使う設計。
複数人が1口座を共有する概念はない |
| D10 | 多通貨対応 | 🔴 | 同上、0件。`amount`/`balance`は`Decimal`のみで通貨コードのフィールド自体が存在しない |
| D11 | 明細・レポーティング | 🟢(取引履歴のみ) | ⓪FC6。ただし確定申告向けの年間取引報告等は🔴 |
| D12 | 限度額・不正検知 | 🟡 | ③L5と同一(重複整理) |
| D13 | KYC・本人確認・口座開設審査 | 🟡 | [[0016-cognito-authentication]]により「本人であることの継続的な確認(認証)」は実装したが、
「その人物が名乗る本人であることの初回確認(本人確認書類の照合等、KYC)」自体は依然スコープ外
——認証と本人確認は別の関心事であり、ADR-0016はセルフサインアップ(誰でもユーザー名を名乗って
登録できる)を明示的に選んでいる |
| D14 | 認証・認可・セッション管理 | 🟢(item単位の読み取り認可を除く) | ①S1と同一(重複整理) |
| D15 | 苦情・紛争処理(組戻し以外の運用プロセス) | 🟡 | 組戻し自体(D3に包含)は実装済み。「苦情受付窓口」等の運用プロセスはCLAUDE.mdが明示する
組織的リアリズム除外の対象 |
| D16 | 休眠口座・強制解約 | 🔵 将来の検証候補 | ADR全体で0件。取引履歴の定期スキャン×既存Freezeコマンド発行という、D5と同型の構成で検証できる |
| D17 | 規制報告・監査(AML/CFT等の当局報告) | 🔵 将来の検証候補 | ADR全体で0件。③L2/L3(監査ログの完全性・改ざん不可能性)とは別物(あちらは技術的な
アウトボックスの性質、こちらは規制当局への報告義務という業務要件)。Query serviceの誕生
([[0004-query-service-event-driven-projection]])と同型の「イベント購読専用の新サービス」で
検証できる |
| D18 | 通知・アラート(プッシュ/email/SMS) | 🟡 | [[0001-service-boundaries-and-event-driven-integration]]が「Notification service」として
明示的にProposed/未実装と記録済み |
| D19 | マルチチャネル対応(ATM/Web/外部チャネル) | 🟢(部分的) | ⓪FC2/FC3、[[0009]]。モバイルアプリ・窓口端末は🔴だが技術検証の性質上妥当な割り切り |
| D20 | 元帳整合性(複式簿記的な資金保存則) | 🔴 | ③L1と同一(重複整理) |

### この層の判定について

D5-D10・D16・D17の7項目(定期振込・金利・手数料・当座貸越・複数名義・多通貨・休眠口座・規制報告)は、
**単に未実装なだけでなく、それを意図してスコープ外にしたという記録自体がどこにも存在しない**
(元々すべて🔴)。これはO1(DLQアラーム未実装)のような「決定はしたが実装が伴っていない」ケースとは
性質が異なる——最初から一度も検討されたことがない。

この7項目は一様ではないことが2026-08-10の議論で判明した。**「イベント駆動だから新しい機能を
既存サービスに一切手を入れず疎結合に追加できるか」という軸で分けると、温度差がある**:

- **D5(定期振込)・D6(金利計算)・D16(休眠口座)・D17(規制報告)** →
  🔵将来の検証候補。いずれも「スケジュール駆動、またはイベント購読で、既存のコマンドキュー/
  イベントストリームに乗るだけの新サービス」として実装できる形をしている。Query service
  ([[0004-query-service-event-driven-projection]])・Transfer service([[0010]])に続く
  3例目・4例目として、[[0001-service-boundaries-and-event-driven-integration]]の「新サービスは
  既存サービスを一切変更せず追加できる」という主張を追加で実証する価値がある。ただし今回は
  バックログとして記録するのみで、実装着手は別途合意する。
- **D7(手数料)** → 🟢実装・検証済み(2026-08-18、[[0024-rewards-service-fee-and-points]])。
  上記の見立て通り「イベント購読×補償サガという既存パターンに最も近い」形——`fee-service`/
  `points-service`という2つの新サービスが既存のコマンド/イベント契約に相乗りするだけで実現でき、
  `account-service`/`query-service`は無改変のまま。D5/D6/D16/D17も同型の構成で検証できる見込みが
  裏付けられた形になる。
- **D8(当座貸越)・D9(複数名義)・D10(多通貨)** → 引き続き⚪(この記事の主張と無関係と判断)。
  これらは`Account::apply`の検証ルールやデータモデル自体の変更を要する、書き込みパスの
  ドメインロジックの話であり、疎結合な新サービス追加では実現できない。イベント駆動性の
  実証には寄与しないため、技術検証の対象外という判断を維持する。

**⚪(D8/D9/D10)についての判断は[CLAUDE.md](../CLAUDE.md)の「Project context」に明文化済み
(2026-08-10)。** 🔵(D5/D6/D16/D17)は「対象外」ではなく「将来やる価値がある」という記録
なので、明文化の必要はなく、このマトリクス自体がバックログとして機能する。

---

## 集計と優先度(2026-08-10時点)

2026-08-10のセッションで、⓪①②③の🔴/🟡だった項目の大半に着手した。実装・実行(または型検証)まで完了したもの:

- **⓪機能的正しさ**: FC3(`Withdraw`負/ゼロ額)・FC5(Frozen→Close)・FC13(NonPositiveAmount)・FC14(サガ二重操作)・FC15(Recall業務境界)
- **①信頼性**: R2(OCCリトライの回復、`aws-smithy-mocks`による単体テスト)・R8(複数発行元の同時競合)
- **①運用上の優秀性**: O1(DLQアラーム実装)・O2(リトライ分岐へのログ追加)
- **③元帳固有リスク**: L1(資金保存則、プロパティベーステスト)・L2(監査ログ完全性、構造的保証と判明)・L3(監査ログ改ざん不可能性、**実装時に本物の過剰権限を発見・修正**)

`cargo test --workspace`(59テスト全合格)・`cargo clippy --workspace --all-targets`(警告0件)・
`infra`の`npm test`(CDK synth、25件全合格、Docker経由のLambdaビルド含む)で全て確認済み。
2026-08-12、デプロイ後に`api-e2e`(22スイート43テスト)・`ui-e2e`(4テスト)をライブスタックに
対して実行し、全て合格を確認した。

**引き続き🚧ブロック中(この session内では完了できない)**: R3・R9・P2・P3・S4・E2の6件。
いずれも障害注入基盤・負荷生成ツール・追加の設計判断(ADR)のいずれかが前提条件になっており、
該当する行に具体的な着手条件を明記した。

④(コアバンキング機能領域)のD8・D9・D10(3件)は、「技術検証の対象外」という判断自体を
CLAUDE.mdに明文化済み(2026-08-10)。D5・D6・D7・D16・D17は🔵将来の検証候補としてバックログ化
済みで、実装着手は別途合意が必要。

**追記(2026-08-18)**: D7(手数料)は[[0024-rewards-service-fee-and-points]]として実装・
デプロイ・`api-e2e`検証まで完了し、🟢に更新した(D7の行・下記6bを参照)。バックログ化していた
残り4件(D5・D6・D16・D17)は引き続き🔵のまま。

## ID体系

`docs/e2e-scenarios.md`の新シナリオIDは、本マトリクスの行ID(`FC#`/`R#`/`O#`/`S#`/`P#`/`E#`/`L#`)をそのまま使う。旧A〜Jのアルファベット割り当ては廃止する。1行ID = 1つ以上のGiven/When/Thenシナリオ(旧ドキュメントと同じ形式)に展開し、優先度P0-P2(旧ドキュメントの定義を継承)を付す。

## 次のステップ

1. ~~🔴/🟡セルそれぞれに対応する新シナリオID体系を設計する~~ → 上記「ID体系」の通り決定
2. ~~既存の`docs/e2e-scenarios.md`のシナリオ(A〜J)を、このマトリクスのどのセルに対応するかへ再マッピングする~~ → 本マトリクスの「根拠(旧ID)」列・各層の根拠列に反映済み
3. ~~新IDに基づいて`docs/e2e-scenarios.md`を全面的に書き直す~~ → 完了(2026-08-10)
4. ~~🔴/🟡のうち自動テストとして実現可能なものから着手し、テストコード(`api-e2e`/`ui-e2e`/単体テスト)を新IDに揃えていく~~ → decision-tables.mdの5件・④の新規発見を反映済み。実際のテストコード追加はこれから
5. ~~全て移行し終えた時点で旧IDへの参照(テストファイルのコメント、README等)を一掃する~~ → 完了(2026-08-10)
6. ~~④のD8・D9・D10(3件)について、「技術検証の対象外」という判断をCLAUDE.mdまたは新規ADRとして明文化する~~ → [CLAUDE.md](../CLAUDE.md)の「Project context」に明文化済み(2026-08-10)
6b. ~~(新規・実装着手は別途合意)~~ D5・D6・D7・D16・D17(🔵将来の検証候補)は本マトリクスにバックログとして記録済み。着手する場合は個別に優先順位を合意する → D7は[[0024-rewards-service-fee-and-points]]として着手・完了(2026-08-18)。残るD5・D6・D16・D17は引き続き個別合意が必要
7. **(新規)優先度の高い🔴/🟡から実際にテストコード・CDK実装・ADR追記に着手する**(FC3が最優先候補)

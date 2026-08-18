# 状態遷移表・ディシジョンテーブル

## 位置づけ

[production-readiness-matrix.md](production-readiness-matrix.md)の①②③層は、このコードベースの
外にある3つの分類軸を先に当てることで、ボトムアップ(コードを読んで気づく)の限界を克服した。
しかし同マトリクスの**⓪機能的正しさ層(FC1-FC13)は、旧`docs/e2e-scenarios.md`のシナリオを
手で読んで移しただけで、実はボトムアップのままだった**。

⓪層には①②③のような「このコードベースの外にある分類軸」がそのままでは存在しない(機能の
正しさは個々のドメインロジックに固有のため)。しかし`AccountState`/`SagaState`は有限状態機械
であり、`Account::apply`/`TransferSaga::start`は有限個の条件分岐を持つ**決定論的関数**なので、
状態×イベント、条件×結果を**格子状に機械的に列挙**できる。空欄(検証されていない組み合わせ)が
プロースでは見つけられなかった箇所を暴く。CLAUDE.mdが`account-domain`の`match`文にワイルドカード
(`_ =>`)を禁止しているのと同じ規律を、テスト/シナリオ側にも適用したものである。

**凡例**: ✅ E2E検証済み | 🔸 単体テストのみ(E2Eなし) | ❌ 単体・E2Eとも未検証

---

## Account: 状態 × コマンド

[account.rs](../crates/account-domain/src/account.rs)の`Account::apply`/`apply_to_absent`を
機械的に列挙。

| 状態 \ コマンド | Open | Deposit(正常) | Deposit(負/0) | Deposit(精度>2桁) | Withdraw(正常) | Withdraw(残高不足) | Withdraw(負/0) | Withdraw(精度>2桁) | Freeze | Unfreeze | Close |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **(未開設)** | ✅ Opened | Err(NotFound) ✅ | - | - | Err(NotFound) 🔸 | - | - | - | Err(NotFound) 🔸 | Err(NotFound) 🔸 | Err(NotFound) 🔸 |
| **Active** | Err(AlreadyExists) ✅ | ✅ Deposited | ✅ Err(InvalidAmount) | ❌ Err(InvalidAmountPrecision) | ✅ Withdrawn | ✅ Err(InsufficientFunds) | ❌ **Err(InvalidAmount)** | ❌ Err(InvalidAmountPrecision) | ✅ Frozen | Err(AlreadyActive) ✅ | ✅ Closed |
| **Frozen** | Err(AlreadyExists) 🔸 | Err(AccountFrozen) ✅ | - | - | Err(AccountFrozen) ✅ | - | - | - | Err(AlreadyFrozen) ✅ | ✅ Unfrozen | ❌ **Ok(Closed)** |
| **Closed** | Err(AlreadyExists) 🔸 | Err(AccountClosed) 🔸(E2Eは1コマンドのみ代表) | - | - | 同左 | - | - | - | 同左 | 同左 | 同左 |

### この表で新たに見つかった穴

1. **`Active`/`Frozen` × `Withdraw`(負またはゼロ額)が単体・E2Eとも一度も検証されていない。**
   `account.rs`の単体テスト`deposit_zero_or_negative_is_rejected`は名前の通りDepositしか
   検証しておらず、対になる`withdraw_zero_or_negative_is_rejected`が存在しない。E2E側の
   旧B8(`domain-errors-active-account.e2e.test.ts`)も`commandApi.deposit(accountId, "-10")`
   のみで、`withdraw`版は呼んでいない。**FC3(`docs/e2e-scenarios.md`)のGiven/When/Thenは
   「負またはゼロ額での出金はいずれも却下され」と書いていたが、これは実際にはテストされて
   いない記述だった**(このドキュメント自体が今回ドリフトを起こしていたことになる。下記で修正)。
2. **`Frozen` × `Close`(`Ok(Closed)`)が単体・E2Eとも一度も検証されていない。**
   `account.rs:227`が`Frozen`状態でも`Close`を受理して`Closed`イベントを生成することを
   コードは示しているが、単体テストの`closed_account_rejects_all_commands`は`Active`から
   `Close`した口座を使っており、`Frozen`から直接`Close`する経路は一度も通っていない。
   凍結中の口座をそのまま解約できるか(先に解除が必要か)という業務上重要な性質にもかかわらず。
3. **精度超過(`InvalidAmountPrecision`)はDeposit/Withdrawどちらもドメイン層では単体テスト済みだが、
   E2Eでは一度も到達していない。** `production-readiness-matrix.md` FC7で判明済みの通り、
   APIGWの構造検証(`^-?\d+(\.\d{1,2})?$`)がこの精度超過ケースを先に`4xx`で止めるため、
   直接SQSを叩かない限りこのドメイン層のコードパス自体に到達しない。

---

## TransferSaga: 状態 × トリガー

[saga.rs](../crates/transfer-service/src/saga.rs)の`confirm`/`cancel`/`advance`/
`reserve_fee_observed`を機械的に列挙。[[0024-rewards-service-fee-and-points]]で
`ReservingFee`状態と`reserve_fee_observed`(専用トリガー`FeeReserved`)を追加したため
更新した(2026-08-18、この決定表を先に更新してから`docs/e2e-scenarios.md`へ反映する運用、
本ファイル末尾の規約通り)。`Observed(Accepted/Rejected)`は`expected_step`が`None`を返す状態
(終端状態・`PendingConfirmation`)には通常到達しない(呼び出し側が観測ロジックの対象にしない)
ため、その行は防御的no-opとしてコードに存在するのみ——`ReservingFee`も同じ理由で
`Observed(*)`は防御的no-opであり、実際の遷移は専用の`FeeReserved`トリガー
(`reserve_fee_observed`)が担う。`furikae`/`recall`は`cash_fee`/`points_used`が常に`ZERO`の
ため`ReservingFee`を経由せず`start()`が直接`PendingDebit`へ進む(表には現れない)。

| 状態 \ トリガー | Confirm | Cancel | FeeReserved | Observed(Accepted) | Observed(Rejected) |
|---|---|---|---|---|---|
| **PendingConfirmation** | ✅ → ReservingFee(`IssueReserveFee`発行) | ✅ → Cancelled | - | 🔸 no-op(防御的) | 🔸 no-op(防御的) |
| **ReservingFee** | ❌ Err(NotPendingConfirmation) | ❌ Err(NotPendingConfirmation) | ✅ → PendingDebit(送金額+現金負担分の手数料で`Withdraw`) | 🔸 no-op(防御的、`advance`経由では到達しない設計) | 🔸 no-op(同左。`fee-service`は原資確保を拒否しない設計のため実際には届かない、決定3) |
| **PendingDebit** | ❌ Err(NotPendingConfirmation) | ❌ Err(NotPendingConfirmation) | - | ✅ → PendingCredit | ✅ → Failed [furikomiなら`IssueRefundFee`も発行、✅] |
| **PendingCredit** | ❌ Err(NotPendingConfirmation) | ❌ Err(NotPendingConfirmation) | - | ✅ → Credited [furikomiなら`IssueAwardPoints`も発行、✅] | ✅ → Compensating |
| **Compensating** | ❌ Err(NotPendingConfirmation) | ❌ Err(NotPendingConfirmation) | - | ✅(R6/旧J3に内包) → Compensated [furikomiなら`IssueRefundFee`も発行、✅(2026-08-18)] | 🔸 no-op(意図的にスコープ外、R7) |
| **Credited**(終端) | ❌ | ❌ | - | 🔸 no-op(防御的) | 🔸 no-op(防御的) |
| **Compensated**(終端) | ❌ | ❌ | - | 🔸 | 🔸 |
| **Failed**(終端) | ❌ | ❌ | - | 🔸 | 🔸 |
| **Cancelled**(終端) | ❌ | ❌ | - | 🔸 | 🔸 |

### この表で新たに見つかった穴

4. **既に`PendingConfirmation`を過ぎたサガへ`Confirm`/`Cancel`を送った場合の拒否
   (`ConfirmError`/`CancelError::NotPendingConfirmation`)が、単体テストのみでE2E未検証。**
   二重確認・確認後のキャンセル試行といった、UIの二度押しやネットワーク再送で現実的に起こりうる
   操作。優先度は中程度(P2)だが、`R8`(複数発行元の同時競合)と近い性質の問題であり、
   実装コストは低い。
6. ~~`Compensating`→`Compensated`遷移時の`IssueRefundFee`発行がE2E未検証~~ →
   **対応済み(2026-08-18)**。受取人側の口座を凍結してから振込み、`PendingCredit`の
   `Deposit`が`AccountFrozen`で却下されて`Compensating`→`Compensated`へ進む経路を
   `transfer-fee-and-points.e2e.test.ts`に追加し、ライブスタックに対して実行・合格確認済み
   ——消費した220ptが全額返却されることを確認した。

---

## TransferSaga::start: 条件 × 結果(ディシジョンテーブル)

[saga.rs:150-179](../crates/transfer-service/src/saga.rs#L150-L179)の`start`は4つの独立した
検証を順番に行う。

| # | amount≤0 | 精度>2桁 | from==to | kind=Furikomi かつ amount>上限 | 結果 | 検証 |
|---|---|---|---|---|---|---|
| 1 | Yes | - | - | - | Err(NonPositiveAmount) | ✅(2026-08-10、E2E追加。`production-readiness-matrix.md` FC13) |
| 2 | No | Yes | - | - | Err(InvalidAmountPrecision) | 🔸(単体のみ、APIGWの構造検証が先に4xx拒否するためE2E到達不能。FC7と同種の理由で妥当) |
| 3 | No | No | Yes | - | Err(SameAccount) | ✅(FC10、旧J4) |
| 4 | No | No | No | Yes | Err(ExceedsFurikomiLimit) | ✅(FC11、旧J8) |
| 5 | No | No | No | No | Ok(saga作成) | ✅(FC10/FC11) |

行1・2は既知(FC13)。新たな発見はないが、この表によって「4条件のうち2つだけがE2E済み」という
比率がプロースより一目でわかる。

---

## TransferSaga::recall_eligibility: 条件 × 結果(ディシジョンテーブル)

[saga.rs:236-247](../crates/transfer-service/src/saga.rs#L236-L247)の`recall_eligibility`。

| # | kind≠Furikomi | state≠Credited | 時間窓超過 | 結果 | 検証 |
|---|---|---|---|---|---|
| 1 | Yes | - | - | Err(NotFurikomi) | ✅(2026-08-10、E2E追加。`transfer-recall.e2e.test.ts`) |
| 2 | No | Yes | - | Err(NotCredited) | 🔸(単体で全状態を網羅、E2Eは実運用上到達させにくいため妥当) |
| 3 | No | No | Yes | Err(WindowExpired) | ✅(FC12、旧J10) |
| 4 | No | No | No | Ok(recall許可) | ✅(FC12、旧J9) |

### この表で新たに見つかった穴

5. **振替(Furikae)や組戻し(Recall)自体に対して`Recall`を要求した場合の却下
   (`RecallError::NotFurikomi`)が、E2Eで一度も検証されていない。**
   `transfer-recall.e2e.test.ts`はJ9(時間窓内の組戻し成功)とJ10(残高不足/時間窓超過)しか
   カバーしておらず、「振替に対してrecallを試みる」ケースは存在しない。組戻しは振込
   (Furikomi)専用の操作であり、この境界(振替では組戻せない)はUIの導線設計にも影響する
   業務ルールである。

---

## まとめ: 見つかった6件

| # | 内容 | 優先度 | 影響する既存文書 |
|---|---|---|---|
| 1 | ~~`Withdraw`の負/ゼロ額が単体・E2Eとも未検証~~ → **対応済み(2026-08-10)** | 済 | `account.rs`に`withdraw_zero_or_negative_is_rejected`単体テスト追加(`cargo test -p account-domain`で合格確認済み)、`domain-errors-active-account.e2e.test.ts`にE2Eテスト追加、ライブスタックに対して実行・合格確認済み(2026-08-12) |
| 2 | ~~`Frozen`→`Close`が単体・E2Eとも未検証~~ → **対応済み(2026-08-10)** | 済 | `account.rs`に`frozen_account_can_be_closed_directly_without_unfreezing_first`単体テスト追加(合格確認済み)、E2E追加、ライブスタックに対して実行・合格確認済み(2026-08-12) |
| 3 | 精度超過のDeposit/WithdrawがE2E未到達 | P1(FC7として既知、この表で再確認)。**構造的に到達不能と結論**——APIGWの構造検証が先に4xx拒否するため、単体テストのみで妥当 | 既存の`production-readiness-matrix.md` FC7と同一 |
| 4 | ~~`Confirm`/`Cancel`の二重操作拒否がE2E未検証~~ → **対応済み(2026-08-10)** | 済 | `transfer-furikomi.e2e.test.ts`にFC14として追加、ライブスタックに対して実行・合格確認済み(2026-08-12) |
| 5 | ~~`RecallError::NotFurikomi`がE2E未検証~~ → **対応済み(2026-08-10)** | 済 | `transfer-recall.e2e.test.ts`にFC15として追加、ライブスタックに対して実行・合格確認済み(2026-08-12) |
| 6 | ~~`Compensating`→`Compensated`遷移時の`IssueRefundFee`発行がE2E未検証~~ → **対応済み(2026-08-18)** | 済 | `transfer-fee-and-points.e2e.test.ts`に追加、ライブスタックに対して実行・合格確認済み(2026-08-18) |

**重要な副産物**: 今回の作業で、`e2e-scenarios.md`のFC3の記述自体が実態より広い保証を謳っていた
(#1)ことが判明した。プロースのシナリオ記述は「書いた時点では正しいつもりでも、実装の詳細までは
突き合わせていない」というドリフトを起こしうることの実例であり、この決定表を`production-
readiness-matrix.md`のマトリクス生成プロセスに組み込み、⓪層を定期的にこの表から再生成する
運用にする価値がある。

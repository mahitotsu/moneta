use account_domain::{Decimal, OffsetDateTime, Uuid, AMOUNT_DECIMAL_PLACES};
use serde::{Deserialize, Serialize};
use time::Duration;

/// 振替(同一名義間)か振込(名義不一致)かの区別(docs/adr/0011)。名義の突き合わせは
/// クライアント申告ではなく呼び出し側(command_intake.rsの口座名義インデックス投影)が
/// サーバ側で判定した結果をここへ渡す——`saga`モジュール自身は名義データソースを一切知らない。
///
/// `Recall`は組戻し(受取人から送金元への逆送金)専用。振込の結果を取り消す操作であって
/// 新規の振込/振替のどちらでもないため独立したバリアントとし、`start`の確認要否判定
/// (振込のみ確認必須)から除外する——組戻しは銀行(システム)が起動する取消処理であり、
/// 顧客が新たに送信を確認する対象ではない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransferKind {
    Furikae,
    Furikomi,
    Recall,
}

/// 振込(`Furikomi`)にのみ確認画面を要求するかどうか(docs/adr/0011)。振替(自分の口座間)・
/// 組戻しは即座に開始する。
fn requires_confirmation(kind: TransferKind) -> bool {
    matches!(kind, TransferKind::Furikomi)
}

/// 振込の1件あたり上限額(docs/adr/0011)。実際の銀行の限度額ポリシー(顧客ごとの可変設定、
/// 認証方式による段階制等)を再現するものではなく、「振込には振替より厳しい制約がある」ことを
/// 技術的に検証可能な形で示すための固定値。振替・組戻しには適用しない。
fn furikomi_max_amount() -> Decimal {
    Decimal::from(1_000_000)
}

/// 組戻し(recall)が許される時間窓(docs/adr/0011)。実際の銀行の組戻し可否(受取人の同意取得、
/// 資金の利用有無の照会等の運用プロセス)を再現するものではなく、時間窓という技術的に検証可能な
/// 代理指標だけを実装する——この単純化は意図的なPoCスコープの割り切りであり、ADRに明記する。
const RECALL_WINDOW: Duration = Duration::hours(24);

/// 送金サガの状態。DynamoDBの1アイテム=1サガ(docs/adr/0010決定2)。account-domainの
/// `AccountState`と同じ流儀で、per-variantデータを持つenumとして表現する。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state")]
pub enum SagaState {
    /// 振込の確認待ち。まだaccount-serviceには何も発行していない(docs/adr/0011)。
    PendingConfirmation,
    /// 送金元への`Withdraw`コマンドを発行し、その結果(成功/却下)を待っている。
    PendingDebit,
    /// 出金は成功した。送金先への`Deposit`コマンドを発行し、その結果を待っている。
    PendingCredit,
    /// 入金が却下されたため、送金元へ補償の`Deposit`(同額の逆入金)を発行し、その結果を
    /// 待っている。
    Compensating,
    /// 完了(出金・入金とも成功)。終端状態。
    Credited,
    /// 補償が完了した(送金前と同じ残高に戻った)。終端状態。
    Compensated,
    /// 出金自体が却下された(残高不足等)。まだ何も動いていないため補償は不要。終端状態。
    Failed,
    /// 確認前に取消された。まだ何も動いていないため補償は不要。終端状態(docs/adr/0011)。
    Cancelled,
}

/// account-serviceから観測した、直前に発行したコマンドの結果。`account.event.*`
/// (成功)か`account.rejection.*`(却下)かに単純化したもの——具体的にどのイベント種別かは
/// サガの状態(今どのステップを待っているか)から自明なので、サガ自体はそれを知る必要がない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservedOutcome {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransferSaga {
    /// account-serviceへ発行するコマンドの`correlation_id`と同じ値(docs/adr/0010決定4)。
    pub transfer_id: String,
    pub from_account_id: Uuid,
    pub to_account_id: Uuid,
    pub amount: Decimal,
    pub kind: TransferKind,
    pub state: SagaState,
    /// 直近の状態遷移時刻。`Credited`に達した時刻の代用として使う(終端到達後は変化しないため
    /// 「いつCreditedになったか」として十分)——組戻しの時間窓判定(`recall_eligibility`)に使う
    /// (docs/adr/0011)。
    pub updated_at: OffsetDateTime,
}

/// サガ状態遷移の結果、呼び出し側(Lambda glue)が実際に行うべきこと。
#[derive(Debug, Clone, PartialEq)]
pub enum NextAction {
    IssueWithdraw { account_id: Uuid, amount: Decimal },
    IssueDeposit { account_id: Uuid, amount: Decimal },
    IssueCompensatingDeposit { account_id: Uuid, amount: Decimal },
    /// 終端状態に達した、確認待ち/取消済みで何も発行していない、または補償自体が却下され
    /// 滞留した(docs/adr/0010の「本ADRのスコープ外」——運用アラートでの手動対応を前提とする)。
    None,
}

/// 今のサガが待っている「次の一歩」の識別情報。全ステップが同じ`correlation_id`
/// (`transfer_id`)を使う(docs/adr/0010決定4)ため、`correlation_id`が一致するというだけでは
/// 「どのステップの結果か」までは分からない——出金・入金・補償入金はいずれも同じ
/// `correlation_id`を持つ。EventBridgeのat-least-once配信により、既に追い越した古いステップの
/// イベントが後から届くことがあるため、呼び出し側(Lambda glue)は観測したイベントの
/// `account_id`とイベント種別名がこれと一致する場合のみ`advance`を呼ぶべきで、一致しなければ
/// 無関係な(古い/重複した)イベントとして無視しなければならない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExpectedStep {
    pub account_id: Uuid,
    /// "event"のときのみ意味を持つイベントバリアント名(例: "Withdrawn")。"rejection"は
    /// `DomainError`のどのバリアントでも「却下された」という事実自体で十分なので、
    /// 呼び出し側はrejectionについてはこの値と突き合わせる必要はなく、`account_id`だけ
    /// 確認すればよい。
    pub event_variant: &'static str,
}

/// 終端状態(`Credited`/`Compensated`/`Failed`/`Cancelled`)と確認待ち(`PendingConfirmation`)
/// では`None`——後者はまだaccount-serviceに何も発行していないため、そもそも観測すべき
/// イベントが存在しない。
pub fn expected_step(saga: &TransferSaga) -> Option<ExpectedStep> {
    match saga.state {
        SagaState::PendingConfirmation => None,
        SagaState::PendingDebit => Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "Withdrawn" }),
        SagaState::PendingCredit => Some(ExpectedStep { account_id: saga.to_account_id, event_variant: "Deposited" }),
        SagaState::Compensating => Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "Deposited" }),
        SagaState::Credited | SagaState::Compensated | SagaState::Failed | SagaState::Cancelled => None,
    }
}

/// `start`が受理できない、決定論的に確定した入力エラー。account-domainの`DomainError`と
/// 同じ位置づけ——リトライしても結果は変わらないため、呼び出し側は再試行してはならない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartError {
    NonPositiveAmount,
    SameAccount,
    /// docs/adr/0006決定5: 金額は小数点以下ちょうど2桁までという契約(account-domainの
    /// `AMOUNT_DECIMAL_PLACES`が単一の真実源)。Transfer serviceは顧客向けコマンドAPIの
    /// JSON Schema検証を経由しない(docs/adr/0010決定6)ため、ここで自前に検証しないと、
    /// account-serviceへコマンド発行するまで(DomainError::InvalidAmountPrecisionとして
    /// 却下されるまで)不正な精度に気づけない。
    InvalidAmountPrecision,
    /// 振込(`Furikomi`)の上限額を超えている(docs/adr/0011)。振替・組戻しには適用されない。
    ExceedsFurikomiLimit,
}

/// 新しい送金を受け付け、初期状態のサガと最初のアクションを返す。`kind`は呼び出し側
/// (command_intake.rs)が名義インデックス投影を引いた結果を渡す——`saga`モジュール自身は
/// 名義データソースを知らない。
///
/// - `Furikae`/`Recall`は確認不要で即座に`PendingDebit`へ進み、出金コマンドを発行する。
/// - `Furikomi`は`PendingConfirmation`で止まり、何も発行しない。`confirm`が呼ばれるまで
///   account-serviceには一切コマンドが送られない(docs/adr/0011)。
pub fn start(
    transfer_id: String,
    from_account_id: Uuid,
    to_account_id: Uuid,
    amount: Decimal,
    kind: TransferKind,
    now: OffsetDateTime,
) -> Result<(TransferSaga, NextAction), StartError> {
    if amount <= Decimal::ZERO {
        return Err(StartError::NonPositiveAmount);
    }
    if amount.scale() > AMOUNT_DECIMAL_PLACES {
        return Err(StartError::InvalidAmountPrecision);
    }
    if from_account_id == to_account_id {
        return Err(StartError::SameAccount);
    }
    if kind == TransferKind::Furikomi && amount > furikomi_max_amount() {
        return Err(StartError::ExceedsFurikomiLimit);
    }

    let (state, action) = if requires_confirmation(kind) {
        (SagaState::PendingConfirmation, NextAction::None)
    } else {
        (SagaState::PendingDebit, NextAction::IssueWithdraw { account_id: from_account_id, amount })
    };

    let saga = TransferSaga { transfer_id, from_account_id, to_account_id, amount, kind, state, updated_at: now };
    Ok((saga, action))
}

/// `confirm`/`cancel`が受理できない入力エラー——`PendingConfirmation`以外のサガに対して
/// 呼ばれた場合(二重確認、既に取消/失効済み等)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmError {
    NotPendingConfirmation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelError {
    NotPendingConfirmation,
}

/// 振込の確認。`PendingConfirmation`のサガのみ受理し、`PendingDebit`へ進めて出金コマンドの
/// 発行を指示する(docs/adr/0011)。
pub fn confirm(saga: &TransferSaga, now: OffsetDateTime) -> Result<(TransferSaga, NextAction), ConfirmError> {
    if saga.state != SagaState::PendingConfirmation {
        return Err(ConfirmError::NotPendingConfirmation);
    }
    let next = TransferSaga { state: SagaState::PendingDebit, updated_at: now, ..saga.clone() };
    let action = NextAction::IssueWithdraw { account_id: saga.from_account_id, amount: saga.amount };
    Ok((next, action))
}

/// 振込の取消(確認前のキャンセル)。`PendingConfirmation`のサガのみ受理し、`Cancelled`へ
/// 進める。まだ何もaccount-serviceに発行していないため、これ以上のアクションはない
/// (docs/adr/0011)。
pub fn cancel(saga: &TransferSaga, now: OffsetDateTime) -> Result<(TransferSaga, NextAction), CancelError> {
    if saga.state != SagaState::PendingConfirmation {
        return Err(CancelError::NotPendingConfirmation);
    }
    let next = TransferSaga { state: SagaState::Cancelled, updated_at: now, ..saga.clone() };
    Ok((next, NextAction::None))
}

/// 組戻し(recall)が許される条件を満たすかどうかを判定する純粋関数。呼び出し側
/// (command_intake.rs)はこれが`Ok`を返したときのみ、`start`を`kind = Recall`・
/// `from = original.to_account_id`・`to = original.from_account_id`で呼び出し、新しい
/// (元とは別の)`transfer_id`を持つ独立したサガとして組戻しを実行する——新しい終端状態は
/// 追加しない(docs/adr/0011)。
///
/// 受取人側の出金が却下される場合(既に資金が使われた、口座が凍結/解約された等)は、
/// 通常の`PendingDebit`+却下→`Failed`の経路がそのまま「組戻し失敗」を表現する——それは
/// このサガ(組戻し自体)の`advance`が扱う話であり、`recall_eligibility`は元の振込サガに
/// 対する事前条件のチェックに過ぎない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecallError {
    /// 振込(`Furikomi`)以外は組戻しの対象外——振替は同一名義間の資金移動であり、顧客自身が
    /// 別の振替をやり直せば足りる。組戻し自体(`Recall`)も再帰的に組戻しの対象にはしない。
    NotFurikomi,
    /// まだ着金していない、または既に失敗/補償/取消済みのサガは組戻しの対象外。
    NotCredited,
    /// 組戻し可能な時間窓(`RECALL_WINDOW`)を過ぎている。
    WindowExpired,
}

pub fn recall_eligibility(original: &TransferSaga, now: OffsetDateTime) -> Result<(), RecallError> {
    if original.kind != TransferKind::Furikomi {
        return Err(RecallError::NotFurikomi);
    }
    if original.state != SagaState::Credited {
        return Err(RecallError::NotCredited);
    }
    if now - original.updated_at > RECALL_WINDOW {
        return Err(RecallError::WindowExpired);
    }
    Ok(())
}

/// 観測結果を反映して次の状態・アクションを決める純粋関数。account-domainの`Account::apply`/
/// `evolve`と同じく、外側(DynamoDB・EventBridge)には一切触れない。
///
/// `SagaState`の全バリアントを明示的に扱う(ワイルドカードなし) — 新しい状態を追加したら
/// ここが必ずコンパイルエラーになる。終端状態(`Credited`/`Compensated`/`Failed`/`Cancelled`)と
/// `PendingConfirmation`(まだaccount-serviceに何も発行していない)は、以後どんな観測結果が
/// 来ても状態を変えないno-op——`PendingConfirmation`/`Cancelled`のサガに対して`advance`が
/// 呼ばれること自体、通常は起こらない(`expected_step`が`None`を返すため観測ロジックの対象に
/// ならない)が、万一の呼び出しに備えて安全側に倒す。
pub fn advance(saga: &TransferSaga, observed: ObservedOutcome) -> (SagaState, NextAction) {
    match saga.state {
        SagaState::PendingConfirmation => (SagaState::PendingConfirmation, NextAction::None),
        SagaState::PendingDebit => match observed {
            ObservedOutcome::Accepted => (
                SagaState::PendingCredit,
                NextAction::IssueDeposit { account_id: saga.to_account_id, amount: saga.amount },
            ),
            ObservedOutcome::Rejected => (SagaState::Failed, NextAction::None),
        },
        SagaState::PendingCredit => match observed {
            ObservedOutcome::Accepted => (SagaState::Credited, NextAction::None),
            ObservedOutcome::Rejected => (
                SagaState::Compensating,
                NextAction::IssueCompensatingDeposit { account_id: saga.from_account_id, amount: saga.amount },
            ),
        },
        SagaState::Compensating => match observed {
            ObservedOutcome::Accepted => (SagaState::Compensated, NextAction::None),
            // 補償自体の却下はスコープ外(docs/adr/0010)。状態を変えず滞留させ、運用側の
            // 検知(今後の課題)に委ねる。
            ObservedOutcome::Rejected => (SagaState::Compensating, NextAction::None),
        },
        SagaState::Credited | SagaState::Compensated | SagaState::Failed | SagaState::Cancelled => {
            (saga.state.clone(), NextAction::None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn now() -> OffsetDateTime {
        OffsetDateTime::UNIX_EPOCH
    }

    fn saga_in(kind: TransferKind, state: SagaState) -> TransferSaga {
        TransferSaga {
            transfer_id: "transfer-1".to_string(),
            from_account_id: Uuid::new_v4(),
            to_account_id: Uuid::new_v4(),
            amount: dec!(100),
            kind,
            state,
            updated_at: now(),
        }
    }

    #[test]
    fn start_furikae_produces_pending_debit_and_issues_withdraw_from_the_source_account() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        let (saga, action) = start("transfer-1".to_string(), from, to, dec!(500), TransferKind::Furikae, now()).unwrap();
        assert_eq!(saga.state, SagaState::PendingDebit);
        assert_eq!(saga.kind, TransferKind::Furikae);
        assert_eq!(action, NextAction::IssueWithdraw { account_id: from, amount: dec!(500) });
    }

    #[test]
    fn start_recall_behaves_like_furikae_no_confirmation_required() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        let (saga, action) = start("recall-1".to_string(), from, to, dec!(500), TransferKind::Recall, now()).unwrap();
        assert_eq!(saga.state, SagaState::PendingDebit);
        assert_eq!(action, NextAction::IssueWithdraw { account_id: from, amount: dec!(500) });
    }

    #[test]
    fn start_furikomi_stops_at_pending_confirmation_and_issues_nothing() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        let (saga, action) = start("transfer-1".to_string(), from, to, dec!(500), TransferKind::Furikomi, now()).unwrap();
        assert_eq!(saga.state, SagaState::PendingConfirmation);
        assert_eq!(saga.kind, TransferKind::Furikomi);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn start_furikomi_exceeding_the_limit_is_rejected() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        assert_eq!(
            start("t".to_string(), from, to, dec!(1000000.01), TransferKind::Furikomi, now()),
            Err(StartError::ExceedsFurikomiLimit)
        );
        // ちょうど上限額は許可される。
        assert!(start("t".to_string(), from, to, dec!(1000000), TransferKind::Furikomi, now()).is_ok());
    }

    #[test]
    fn start_furikae_is_not_subject_to_the_furikomi_limit() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        assert!(start("t".to_string(), from, to, dec!(5000000), TransferKind::Furikae, now()).is_ok());
    }

    #[test]
    fn start_rejects_non_positive_amounts() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        assert_eq!(
            start("t".to_string(), from, to, dec!(0), TransferKind::Furikae, now()),
            Err(StartError::NonPositiveAmount)
        );
        assert_eq!(
            start("t".to_string(), from, to, dec!(-1), TransferKind::Furikae, now()),
            Err(StartError::NonPositiveAmount)
        );
    }

    #[test]
    fn start_rejects_amounts_with_more_than_two_decimal_places() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        assert_eq!(
            start("t".to_string(), from, to, dec!(10.123), TransferKind::Furikae, now()),
            Err(StartError::InvalidAmountPrecision)
        );
        // ちょうど2桁は許可される。
        assert!(start("t".to_string(), from, to, dec!(10.12), TransferKind::Furikae, now()).is_ok());
    }

    #[test]
    fn start_rejects_transfers_to_the_same_account() {
        let account = Uuid::new_v4();
        assert_eq!(
            start("t".to_string(), account, account, dec!(500), TransferKind::Furikae, now()),
            Err(StartError::SameAccount)
        );
    }

    #[test]
    fn confirm_moves_pending_confirmation_to_pending_debit_and_issues_withdraw() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::PendingConfirmation);
        let (next, action) = confirm(&saga, now()).unwrap();
        assert_eq!(next.state, SagaState::PendingDebit);
        assert_eq!(action, NextAction::IssueWithdraw { account_id: saga.from_account_id, amount: saga.amount });
    }

    #[test]
    fn confirm_rejects_sagas_not_pending_confirmation() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::PendingDebit);
        assert_eq!(confirm(&saga, now()), Err(ConfirmError::NotPendingConfirmation));
    }

    #[test]
    fn cancel_moves_pending_confirmation_to_cancelled_and_issues_nothing() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::PendingConfirmation);
        let (next, action) = cancel(&saga, now()).unwrap();
        assert_eq!(next.state, SagaState::Cancelled);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn cancel_rejects_sagas_not_pending_confirmation() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::Credited);
        assert_eq!(cancel(&saga, now()), Err(CancelError::NotPendingConfirmation));
    }

    #[test]
    fn recall_eligibility_accepts_a_credited_furikomi_within_the_window() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::Credited);
        let just_inside_window = saga.updated_at + RECALL_WINDOW - Duration::seconds(1);
        assert_eq!(recall_eligibility(&saga, just_inside_window), Ok(()));
    }

    #[test]
    fn recall_eligibility_rejects_furikae() {
        let saga = saga_in(TransferKind::Furikae, SagaState::Credited);
        assert_eq!(recall_eligibility(&saga, saga.updated_at), Err(RecallError::NotFurikomi));
    }

    #[test]
    fn recall_eligibility_rejects_recall_itself() {
        let saga = saga_in(TransferKind::Recall, SagaState::Credited);
        assert_eq!(recall_eligibility(&saga, saga.updated_at), Err(RecallError::NotFurikomi));
    }

    #[test]
    fn recall_eligibility_rejects_sagas_not_yet_credited() {
        for state in [
            SagaState::PendingConfirmation,
            SagaState::PendingDebit,
            SagaState::PendingCredit,
            SagaState::Compensating,
            SagaState::Compensated,
            SagaState::Failed,
            SagaState::Cancelled,
        ] {
            let saga = saga_in(TransferKind::Furikomi, state);
            assert_eq!(recall_eligibility(&saga, saga.updated_at), Err(RecallError::NotCredited));
        }
    }

    #[test]
    fn recall_eligibility_rejects_after_the_window_has_expired() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::Credited);
        let just_past_window = saga.updated_at + RECALL_WINDOW + Duration::seconds(1);
        assert_eq!(recall_eligibility(&saga, just_past_window), Err(RecallError::WindowExpired));
    }

    #[test]
    fn withdraw_accepted_moves_to_pending_credit_and_issues_deposit_to_destination() {
        let saga = saga_in(TransferKind::Furikae, SagaState::PendingDebit);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::PendingCredit);
        assert_eq!(action, NextAction::IssueDeposit { account_id: saga.to_account_id, amount: saga.amount });
    }

    #[test]
    fn withdraw_rejected_fails_the_saga_without_compensation() {
        let saga = saga_in(TransferKind::Furikae, SagaState::PendingDebit);
        let (next, action) = advance(&saga, ObservedOutcome::Rejected);
        assert_eq!(next, SagaState::Failed);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn deposit_accepted_completes_the_saga() {
        let saga = saga_in(TransferKind::Furikae, SagaState::PendingCredit);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::Credited);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn deposit_rejected_triggers_compensation_back_to_the_source_account() {
        let saga = saga_in(TransferKind::Furikae, SagaState::PendingCredit);
        let (next, action) = advance(&saga, ObservedOutcome::Rejected);
        assert_eq!(next, SagaState::Compensating);
        assert_eq!(action, NextAction::IssueCompensatingDeposit { account_id: saga.from_account_id, amount: saga.amount });
    }

    #[test]
    fn compensating_deposit_accepted_completes_compensation() {
        let saga = saga_in(TransferKind::Furikae, SagaState::Compensating);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::Compensated);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn compensating_deposit_rejected_stays_compensating_without_further_action() {
        let saga = saga_in(TransferKind::Furikae, SagaState::Compensating);
        let (next, action) = advance(&saga, ObservedOutcome::Rejected);
        assert_eq!(next, SagaState::Compensating);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn terminal_states_ignore_further_observations() {
        for state in [SagaState::Credited, SagaState::Compensated, SagaState::Failed, SagaState::Cancelled] {
            let saga = saga_in(TransferKind::Furikae, state.clone());
            let (next, action) = advance(&saga, ObservedOutcome::Accepted);
            assert_eq!(next, state.clone());
            assert_eq!(action, NextAction::None);

            let (next, action) = advance(&saga, ObservedOutcome::Rejected);
            assert_eq!(next, state);
            assert_eq!(action, NextAction::None);
        }
    }

    #[test]
    fn pending_confirmation_ignores_observations_as_a_defensive_no_op() {
        // 通常はexpected_stepがNoneを返すため、PendingConfirmationのサガに対して`advance`が
        // 呼ばれること自体起こらないはずだが、万一呼ばれても状態を変えないことを固定する。
        let saga = saga_in(TransferKind::Furikomi, SagaState::PendingConfirmation);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::PendingConfirmation);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn expected_step_tracks_which_account_and_event_variant_the_saga_is_currently_waiting_on() {
        let saga = saga_in(TransferKind::Furikae, SagaState::PendingDebit);
        assert_eq!(
            expected_step(&saga),
            Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "Withdrawn" })
        );

        let saga = saga_in(TransferKind::Furikae, SagaState::PendingCredit);
        assert_eq!(
            expected_step(&saga),
            Some(ExpectedStep { account_id: saga.to_account_id, event_variant: "Deposited" })
        );

        // 補償の入金先はfrom_account_id(送金元)であり、PendingDebitと同じ口座を待つが、
        // 期待するイベント種別はWithdrawnではなくDeposited(補償は入金コマンドのため)。
        let saga = saga_in(TransferKind::Furikae, SagaState::Compensating);
        assert_eq!(
            expected_step(&saga),
            Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "Deposited" })
        );
    }

    #[test]
    fn expected_step_is_none_for_terminal_states_and_pending_confirmation() {
        for state in [
            SagaState::Credited,
            SagaState::Compensated,
            SagaState::Failed,
            SagaState::Cancelled,
            SagaState::PendingConfirmation,
        ] {
            assert_eq!(expected_step(&saga_in(TransferKind::Furikomi, state)), None);
        }
    }
}

use account_domain::{Decimal, Uuid, AMOUNT_DECIMAL_PLACES};
use serde::{Deserialize, Serialize};

/// 送金サガの状態。DynamoDBの1アイテム=1サガ(docs/adr/0010決定2)。account-domainの
/// `AccountState`と同じ流儀で、per-variantデータを持つenumとして表現する。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state")]
pub enum SagaState {
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
    pub state: SagaState,
}

/// サガ状態遷移の結果、呼び出し側(Lambda glue)が実際に行うべきこと。
#[derive(Debug, Clone, PartialEq)]
pub enum NextAction {
    IssueWithdraw { account_id: Uuid, amount: Decimal },
    IssueDeposit { account_id: Uuid, amount: Decimal },
    IssueCompensatingDeposit { account_id: Uuid, amount: Decimal },
    /// 終端状態に達した、または補償自体が却下され滞留した(docs/adr/0010の
    /// 「本ADRのスコープ外」——運用アラートでの手動対応を前提とする)。
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

/// 終端状態(`Credited`/`Compensated`/`Failed`)では`None`——もう何も待っていない。
pub fn expected_step(saga: &TransferSaga) -> Option<ExpectedStep> {
    match saga.state {
        SagaState::PendingDebit => Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "Withdrawn" }),
        SagaState::PendingCredit => Some(ExpectedStep { account_id: saga.to_account_id, event_variant: "Deposited" }),
        SagaState::Compensating => Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "Deposited" }),
        SagaState::Credited | SagaState::Compensated | SagaState::Failed => None,
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
}

/// 新しい送金を受け付け、初期状態のサガと最初のアクション(出金コマンドの発行)を返す。
pub fn start(
    transfer_id: String,
    from_account_id: Uuid,
    to_account_id: Uuid,
    amount: Decimal,
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

    let saga = TransferSaga {
        transfer_id,
        from_account_id,
        to_account_id,
        amount,
        state: SagaState::PendingDebit,
    };
    let action = NextAction::IssueWithdraw { account_id: from_account_id, amount };
    Ok((saga, action))
}

/// 観測結果を反映して次の状態・アクションを決める純粋関数。account-domainの`Account::apply`/
/// `evolve`と同じく、外側(DynamoDB・EventBridge)には一切触れない。
///
/// `SagaState`の全バリアントを明示的に扱う(ワイルドカードなし) — 新しい状態を追加したら
/// ここが必ずコンパイルエラーになる。終端状態(`Credited`/`Compensated`/`Failed`)は
/// 以後どんな観測結果が来ても状態を変えない(at-least-once配信による重複イベントの
/// 安全な無視で、account-domainの冪等性の考え方と同じ)。
pub fn advance(saga: &TransferSaga, observed: ObservedOutcome) -> (SagaState, NextAction) {
    match saga.state {
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
        SagaState::Credited | SagaState::Compensated | SagaState::Failed => (saga.state.clone(), NextAction::None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn saga_in(state: SagaState) -> TransferSaga {
        TransferSaga {
            transfer_id: "transfer-1".to_string(),
            from_account_id: Uuid::new_v4(),
            to_account_id: Uuid::new_v4(),
            amount: dec!(100),
            state,
        }
    }

    #[test]
    fn start_produces_pending_debit_and_issues_withdraw_from_the_source_account() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        let (saga, action) = start("transfer-1".to_string(), from, to, dec!(500)).unwrap();
        assert_eq!(saga.state, SagaState::PendingDebit);
        assert_eq!(action, NextAction::IssueWithdraw { account_id: from, amount: dec!(500) });
    }

    #[test]
    fn start_rejects_non_positive_amounts() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        assert_eq!(start("t".to_string(), from, to, dec!(0)), Err(StartError::NonPositiveAmount));
        assert_eq!(start("t".to_string(), from, to, dec!(-1)), Err(StartError::NonPositiveAmount));
    }

    #[test]
    fn start_rejects_amounts_with_more_than_two_decimal_places() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        assert_eq!(
            start("t".to_string(), from, to, dec!(10.123)),
            Err(StartError::InvalidAmountPrecision)
        );
        // ちょうど2桁は許可される。
        assert!(start("t".to_string(), from, to, dec!(10.12)).is_ok());
    }

    #[test]
    fn start_rejects_transfers_to_the_same_account() {
        let account = Uuid::new_v4();
        assert_eq!(start("t".to_string(), account, account, dec!(500)), Err(StartError::SameAccount));
    }

    #[test]
    fn withdraw_accepted_moves_to_pending_credit_and_issues_deposit_to_destination() {
        let saga = saga_in(SagaState::PendingDebit);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::PendingCredit);
        assert_eq!(action, NextAction::IssueDeposit { account_id: saga.to_account_id, amount: saga.amount });
    }

    #[test]
    fn withdraw_rejected_fails_the_saga_without_compensation() {
        let saga = saga_in(SagaState::PendingDebit);
        let (next, action) = advance(&saga, ObservedOutcome::Rejected);
        assert_eq!(next, SagaState::Failed);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn deposit_accepted_completes_the_saga() {
        let saga = saga_in(SagaState::PendingCredit);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::Credited);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn deposit_rejected_triggers_compensation_back_to_the_source_account() {
        let saga = saga_in(SagaState::PendingCredit);
        let (next, action) = advance(&saga, ObservedOutcome::Rejected);
        assert_eq!(next, SagaState::Compensating);
        assert_eq!(action, NextAction::IssueCompensatingDeposit { account_id: saga.from_account_id, amount: saga.amount });
    }

    #[test]
    fn compensating_deposit_accepted_completes_compensation() {
        let saga = saga_in(SagaState::Compensating);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::Compensated);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn compensating_deposit_rejected_stays_compensating_without_further_action() {
        let saga = saga_in(SagaState::Compensating);
        let (next, action) = advance(&saga, ObservedOutcome::Rejected);
        assert_eq!(next, SagaState::Compensating);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn terminal_states_ignore_further_observations() {
        for state in [SagaState::Credited, SagaState::Compensated, SagaState::Failed] {
            let saga = saga_in(state.clone());
            let (next, action) = advance(&saga, ObservedOutcome::Accepted);
            assert_eq!(next, state.clone());
            assert_eq!(action, NextAction::None);

            let (next, action) = advance(&saga, ObservedOutcome::Rejected);
            assert_eq!(next, state);
            assert_eq!(action, NextAction::None);
        }
    }

    #[test]
    fn expected_step_tracks_which_account_and_event_variant_the_saga_is_currently_waiting_on() {
        let saga = saga_in(SagaState::PendingDebit);
        assert_eq!(
            expected_step(&saga),
            Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "Withdrawn" })
        );

        let saga = saga_in(SagaState::PendingCredit);
        assert_eq!(
            expected_step(&saga),
            Some(ExpectedStep { account_id: saga.to_account_id, event_variant: "Deposited" })
        );

        // 補償の入金先はfrom_account_id(送金元)であり、PendingDebitと同じ口座を待つが、
        // 期待するイベント種別はWithdrawnではなくDeposited(補償は入金コマンドのため)。
        let saga = saga_in(SagaState::Compensating);
        assert_eq!(
            expected_step(&saga),
            Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "Deposited" })
        );
    }

    #[test]
    fn expected_step_is_none_for_terminal_states() {
        for state in [SagaState::Credited, SagaState::Compensated, SagaState::Failed] {
            assert_eq!(expected_step(&saga_in(state)), None);
        }
    }
}

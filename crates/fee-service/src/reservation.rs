use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 手数料額の決定(docs/adr/0024決定2)。`transfer-service`はこの金額を一切知らない
/// (`transfer_amount`を渡すだけ)——v1では固定額だが、将来のステージ別割引・免除は
/// この関数の内部だけで完結する設計にしてある。
pub fn fee_for(_transfer_amount: Decimal) -> Decimal {
    furikomi_fee_amount()
}

/// 振込の手数料固定額(仮の値)。`transfer-service`の`saga.rs`にある`furikomi_max_amount()`と
/// 同じ「PoCスコープの意図的な単純化」——実際の銀行の手数料体系(振込金額に応じた段階制、
/// 時間外手数料等)を再現するものではない。
fn furikomi_fee_amount() -> Decimal {
    Decimal::from(220)
}

/// fee-service自身の予約台帳(`FeeReservationsTable`、docs/adr/0024決定5)の1アイテムを表す。
/// `points-service`とのやり取りの状態を自分の中だけで完結させ、`transfer-service`は
/// `points_used`の値を一切覚えておく必要がない。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state")]
pub enum ReservationState {
    /// `points-service`へ`ReservePoints`を発行し、`PointsReserved`の観測を待っている。
    AwaitingPointsReservation,
    /// 確定した(`points_used`が定まった)。
    Reserved,
    /// 送金が最終的に失敗/補償され、`points_used`分を`points-service`へ返却した。終端状態。
    /// `Reserved`→`Refunded`のCASを`RefundFee`の冪等性チェックに使う——重複配信で`refund`が
    /// 2度呼ばれても、2度目はCASが不成立になり`IssueRefundPoints`を再発行しない
    /// (docs/adr/0024決定5)。
    Refunded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeeReservation {
    pub transfer_id: String,
    pub owner_id: String,
    /// 手数料を負担する送金元口座。fee-service自身のロジックはこの値を一切参照しない
    /// (account-domainに依存しない、docs/adr/0024決定1)——`transfer-service`の`expected_step`が
    /// `fee.event.FeeReserved`をどの口座宛の応答か突き合わせるための輸送専用データとして、
    /// そのまま素通しして`fee.event.FeeReserved`の`account_id`に載せるためだけに持つ。
    pub account_id: Uuid,
    pub fee_amount: Decimal,
    /// `AwaitingPointsReservation`の間は`ZERO`(未確定)。`Reserved`になって初めて意味を持つ。
    pub points_used: Decimal,
    pub state: ReservationState,
}

/// 予約遷移の結果、呼び出し側(Lambda glue)が実際に行うべきこと。
#[derive(Debug, Clone, PartialEq)]
pub enum NextAction {
    IssueReservePoints { owner_id: String, up_to: Decimal },
    /// `transfer-service`が観測する`fee.event.FeeReserved`として発行する(docs/adr/0024決定6:
    /// 呼び出し元が待つ応答なのでアウトボックスを経由する)。
    EmitFeeReserved { cash_portion: Decimal },
    IssueRefundPoints { owner_id: String, amount: Decimal },
    None,
}

/// `transfer-service`からの`ReserveFee`を受けて予約を開始する。`account-domain`の
/// `Account::apply_to_absent`と同じ位置づけ——まだ存在しないレコードに対する最初の遷移。
pub fn start(transfer_id: String, owner_id: String, account_id: Uuid, transfer_amount: Decimal) -> (FeeReservation, NextAction) {
    let fee_amount = fee_for(transfer_amount);
    let reservation = FeeReservation {
        transfer_id,
        owner_id: owner_id.clone(),
        account_id,
        fee_amount,
        points_used: Decimal::ZERO,
        state: ReservationState::AwaitingPointsReservation,
    };
    let action = NextAction::IssueReservePoints { owner_id, up_to: fee_amount };
    (reservation, action)
}

/// `points-service`からの`PointsReserved`観測を受けて予約を確定する。`AwaitingPointsReservation`
/// 以外に対して呼ばれること自体、通常は起こらない(at-least-once配信による重複の可能性はある)が、
/// 防御的にno-opとして扱う——`transfer-service`の`saga.rs`の終端状態に対する`advance`と同じ考え方。
pub fn points_reserved(reservation: &FeeReservation, points_used: Decimal) -> (FeeReservation, NextAction) {
    match reservation.state {
        ReservationState::AwaitingPointsReservation => {
            let cash_portion = reservation.fee_amount - points_used;
            let next = FeeReservation { points_used, state: ReservationState::Reserved, ..reservation.clone() };
            (next, NextAction::EmitFeeReserved { cash_portion })
        }
        ReservationState::Reserved | ReservationState::Refunded => (reservation.clone(), NextAction::None),
    }
}

/// 送金が最終的に失敗/補償された場合の巻き戻し(docs/adr/0024決定5)。`Reserved`からのみ
/// 受理し、`Refunded`へ進める——`AwaitingPointsReservation`(まだ`points_used`が定まって
/// いない)や既に`Refunded`(重複配信)に対しては何もしない。ポイントが実際に消費されていた
/// 場合(`points_used > 0`)のみ`points-service`へ返却を発行する——全額現金で賄われていた
/// 場合は状態だけ`Refunded`に進めてコマンドは発行しない。
pub fn refund(reservation: &FeeReservation) -> (FeeReservation, NextAction) {
    match reservation.state {
        ReservationState::Reserved => {
            let next = FeeReservation { state: ReservationState::Refunded, ..reservation.clone() };
            let action = if reservation.points_used > Decimal::ZERO {
                NextAction::IssueRefundPoints { owner_id: reservation.owner_id.clone(), amount: reservation.points_used }
            } else {
                NextAction::None
            };
            (next, action)
        }
        ReservationState::AwaitingPointsReservation | ReservationState::Refunded => (reservation.clone(), NextAction::None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn start_computes_the_fixed_fee_and_requests_a_points_reservation_up_to_it() {
        let (reservation, action) = start("t1".to_string(), "owner-1".to_string(), Uuid::new_v4(), dec!(50000));
        assert_eq!(reservation.state, ReservationState::AwaitingPointsReservation);
        assert_eq!(reservation.fee_amount, dec!(220));
        assert_eq!(reservation.points_used, dec!(0));
        assert_eq!(action, NextAction::IssueReservePoints { owner_id: "owner-1".to_string(), up_to: dec!(220) });
    }

    #[test]
    fn points_reserved_covering_the_full_fee_leaves_no_cash_portion() {
        let (reservation, _) = start("t1".to_string(), "owner-1".to_string(), Uuid::new_v4(), dec!(50000));
        let (next, action) = points_reserved(&reservation, dec!(220));
        assert_eq!(next.state, ReservationState::Reserved);
        assert_eq!(next.points_used, dec!(220));
        assert_eq!(action, NextAction::EmitFeeReserved { cash_portion: dec!(0) });
    }

    #[test]
    fn points_reserved_partially_covering_the_fee_returns_the_remaining_cash_portion() {
        let (reservation, _) = start("t1".to_string(), "owner-1".to_string(), Uuid::new_v4(), dec!(50000));
        let (next, action) = points_reserved(&reservation, dec!(80));
        assert_eq!(next.points_used, dec!(80));
        assert_eq!(action, NextAction::EmitFeeReserved { cash_portion: dec!(140) });
    }

    #[test]
    fn points_reserved_with_zero_points_used_charges_the_full_fee_in_cash() {
        let (reservation, _) = start("t1".to_string(), "owner-1".to_string(), Uuid::new_v4(), dec!(50000));
        let (next, action) = points_reserved(&reservation, dec!(0));
        assert_eq!(next.points_used, dec!(0));
        assert_eq!(action, NextAction::EmitFeeReserved { cash_portion: dec!(220) });
    }

    #[test]
    fn points_reserved_is_a_no_op_when_already_reserved() {
        let (reservation, _) = start("t1".to_string(), "owner-1".to_string(), Uuid::new_v4(), dec!(50000));
        let (reserved, _) = points_reserved(&reservation, dec!(220));
        let (next, action) = points_reserved(&reserved, dec!(220));
        assert_eq!(next, reserved);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn refund_is_issued_when_points_were_used_and_moves_to_refunded() {
        let (reservation, _) = start("t1".to_string(), "owner-1".to_string(), Uuid::new_v4(), dec!(50000));
        let (reserved, _) = points_reserved(&reservation, dec!(150));
        let (next, action) = refund(&reserved);
        assert_eq!(next.state, ReservationState::Refunded);
        assert_eq!(action, NextAction::IssueRefundPoints { owner_id: "owner-1".to_string(), amount: dec!(150) });
    }

    #[test]
    fn refund_moves_to_refunded_without_a_command_when_the_fee_was_entirely_cash() {
        let (reservation, _) = start("t1".to_string(), "owner-1".to_string(), Uuid::new_v4(), dec!(50000));
        let (reserved, _) = points_reserved(&reservation, dec!(0));
        let (next, action) = refund(&reserved);
        assert_eq!(next.state, ReservationState::Refunded);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn refund_is_a_no_op_when_called_twice() {
        let (reservation, _) = start("t1".to_string(), "owner-1".to_string(), Uuid::new_v4(), dec!(50000));
        let (reserved, _) = points_reserved(&reservation, dec!(150));
        let (refunded, _) = refund(&reserved);
        let (next, action) = refund(&refunded);
        assert_eq!(next, refunded);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn refund_is_a_no_op_while_still_awaiting_points_reservation() {
        let (reservation, _) = start("t1".to_string(), "owner-1".to_string(), Uuid::new_v4(), dec!(50000));
        let (next, action) = refund(&reservation);
        assert_eq!(next, reservation);
        assert_eq!(action, NextAction::None);
    }
}

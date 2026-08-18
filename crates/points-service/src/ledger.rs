//! ポイント残高に対する原子的な操作の計算だけを行う純粋関数群(docs/adr/0024)。
//! account-domainの`Account::apply`/`evolve`と同じ位置づけ——AWS/DBには一切触れず、
//! 実際の永続化(persistence.rs、未実装)はこの計算結果をDynamoDBの
//! `ConditionExpression`付き`UpdateItem`に変換するだけの薄い層にする。
//!
//! points-serviceは`account-domain`のような`Command`/`Event`の状態機械を持たない——
//! 残高という1つの数値に対する「予約(消費)」「加算」の2種類の操作しかなく、それぞれが
//! 独立した単純な計算で完結するため、account-domainほどの構造は不要と判断した。

use rust_decimal::Decimal;

/// `reserve`の結果。呼び出し側(fee-service)へ返す`points_used`と、書き戻すべき新しい残高。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReserveOutcome {
    pub points_used: Decimal,
    pub new_balance: Decimal,
}

/// 手数料充当のためのポイント予約(消費)。保有ポイントの範囲内で`up_to`まで消費する。
///
/// **拒否を返さない設計**(docs/adr/0024決定3)——保有ポイントが0でも`points_used = ZERO`として
/// 常に成立する。「原資が足りない」という状況は、呼び出し側(fee-service)が
/// `fee_amount - points_used`という現金負担分を計算することで自然に表現される。
///
/// `up_to`が負値の場合は呼び出し側のバグであり、ここでは検証しない
/// (fee-serviceが常に非負の`fee_amount`を渡す契約——account-domainの`amount`検証のような
/// 型レベルの強制は、points-serviceの利用者がfee-service1つに限られるため見送った)。
pub fn reserve(balance: Decimal, up_to: Decimal) -> ReserveOutcome {
    let points_used = balance.min(up_to).max(Decimal::ZERO);
    ReserveOutcome { points_used, new_balance: balance - points_used }
}

/// ポイントの加算(付与・返却の両方で使う共通の計算)。失敗しうる条件を持たない単純な加算
/// (docs/adr/0024決定6: `AwardPoints`/`RefundPoints`はfire-and-forgetでよい理由そのもの)。
pub fn credit(balance: Decimal, amount: Decimal) -> Decimal {
    balance + amount
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn reserve_consumes_up_to_the_requested_amount_when_balance_is_sufficient() {
        let outcome = reserve(dec!(500), dec!(220));
        assert_eq!(outcome, ReserveOutcome { points_used: dec!(220), new_balance: dec!(280) });
    }

    #[test]
    fn reserve_consumes_only_the_available_balance_when_insufficient() {
        let outcome = reserve(dec!(100), dec!(220));
        assert_eq!(outcome, ReserveOutcome { points_used: dec!(100), new_balance: dec!(0) });
    }

    #[test]
    fn reserve_never_rejects_a_zero_balance() {
        let outcome = reserve(dec!(0), dec!(220));
        assert_eq!(outcome, ReserveOutcome { points_used: dec!(0), new_balance: dec!(0) });
    }

    #[test]
    fn reserve_of_exactly_the_available_balance_leaves_zero_remaining() {
        let outcome = reserve(dec!(220), dec!(220));
        assert_eq!(outcome, ReserveOutcome { points_used: dec!(220), new_balance: dec!(0) });
    }

    #[test]
    fn credit_adds_to_the_existing_balance() {
        assert_eq!(credit(dec!(100), dec!(50)), dec!(150));
    }

    #[test]
    fn credit_from_a_zero_balance_starts_the_account_at_the_credited_amount() {
        assert_eq!(credit(dec!(0), dec!(30)), dec!(30));
    }
}

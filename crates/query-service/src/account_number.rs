use account_domain::Uuid;
use rand::Rng;

/// 支店の固定一覧(支店番号3桁, 支店名)。この銀行は単一組織で支店間の業務分離は存在しない
/// ため、実在感のための表示・宛先入力用の属性としてのみ持つ(docs/adr/0015決定4)。
pub const BRANCHES: &[(&str, &str)] =
    &[("001", "本店"), ("002", "東京支店"), ("003", "大阪支店"), ("009", "インターネット支店")];

/// 発番する口座番号の桁数。日本の実際の口座番号の桁数に合わせた値であり、このPoCの試験規模
/// では衝突は稀だが、衝突再試行の機構自体を実際に動かして検証する意味があるため、衝突が
/// 起こり得ない桁数まで大きくすることはしない(docs/adr/0015決定3)。
const NUMBER_DIGITS: u32 = 7;

/// `account_id`から決定的に支店を1つ選ぶ(docs/adr/0015決定4)。同じ`account_id`なら常に
/// 同じ支店になる——支店は口座番号と違って一意性を要求しないため、衝突再試行の対象にする
/// 必要がなく、決定的な割り当てにした方が単純でテストしやすい。
pub fn assign_branch(account_id: Uuid) -> (&'static str, &'static str) {
    let index = (account_id.as_u128() % BRANCHES.len() as u128) as usize;
    BRANCHES[index]
}

/// 7桁の口座番号候補をランダム生成する(docs/adr/0015決定3)。ゼロ埋めで常に7桁固定長の
/// 数字列になる。一意性はこの関数では保証しない——呼び出し側が`ConditionExpression`付き
/// `PutItem`で予約し、衝突すれば再度この関数を呼んで作り直す。
pub fn candidate_number(rng: &mut impl Rng) -> String {
    let upper_bound: u32 = 10u32.pow(NUMBER_DIGITS);
    format!("{:0width$}", rng.gen_range(0..upper_bound), width = NUMBER_DIGITS as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assign_branch_is_deterministic_for_the_same_account_id() {
        let id = Uuid::new_v4();
        assert_eq!(assign_branch(id), assign_branch(id));
    }

    #[test]
    fn assign_branch_only_returns_known_branches() {
        for _ in 0..200 {
            let (code, name) = assign_branch(Uuid::new_v4());
            assert!(BRANCHES.contains(&(code, name)), "unexpected branch: {code} {name}");
        }
    }

    #[test]
    fn candidate_number_is_always_seven_digits() {
        let mut rng = rand::thread_rng();
        for _ in 0..200 {
            let candidate = candidate_number(&mut rng);
            assert_eq!(candidate.len(), 7, "candidate {candidate} is not 7 digits");
            assert!(candidate.chars().all(|c| c.is_ascii_digit()), "candidate {candidate} has non-digit chars");
        }
    }
}

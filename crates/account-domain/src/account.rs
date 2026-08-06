use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::ids::AccountId;

/// 口座凍結の理由。バリアントを追加すると `apply` 内の
/// 全マッチ箇所がコンパイルエラーになり、対応漏れを防ぐ。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FreezeReason {
    SuspectedFraud,
    CourtOrder,
    CustomerRequest,
}

/// 口座の状態。各バリアントはその状態でのみ意味を持つデータを保持する
/// （例: `frozen_at` は `Frozen` 状態でしか存在しない）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AccountState {
    Active {
        balance: Decimal,
    },
    Frozen {
        balance: Decimal,
        reason: FreezeReason,
        frozen_at: OffsetDateTime,
    },
    Closed {
        final_balance: Decimal,
        closed_at: OffsetDateTime,
    },
}

/// 口座に対する操作要求。まだ受理されるかどうかは決まっていない。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Command {
    Open { owner_id: String, initial_balance: Decimal },
    Deposit { amount: Decimal },
    Withdraw { amount: Decimal },
    Freeze { reason: FreezeReason },
    Unfreeze,
    Close,
}

/// `apply` が受理した事実。永続化され、`evolve` で状態に畳み込まれる。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Event {
    Opened {
        account_id: AccountId,
        owner_id: String,
        balance: Decimal,
        opened_at: OffsetDateTime,
    },
    Deposited {
        account_id: AccountId,
        amount: Decimal,
        new_balance: Decimal,
    },
    Withdrawn {
        account_id: AccountId,
        amount: Decimal,
        new_balance: Decimal,
    },
    Frozen {
        account_id: AccountId,
        balance: Decimal,
        reason: FreezeReason,
        frozen_at: OffsetDateTime,
    },
    Unfrozen {
        account_id: AccountId,
        balance: Decimal,
    },
    Closed {
        account_id: AccountId,
        final_balance: Decimal,
        closed_at: OffsetDateTime,
    },
}

#[derive(Debug, Clone, PartialEq, thiserror::Error, Serialize, Deserialize)]
pub enum DomainError {
    #[error("insufficient funds: balance {balance} < requested {requested}")]
    InsufficientFunds { balance: Decimal, requested: Decimal },
    #[error("account is frozen: {reason:?}")]
    AccountFrozen { reason: FreezeReason },
    #[error("account is closed")]
    AccountClosed,
    #[error("invalid amount: {0} (must be positive)")]
    InvalidAmount(Decimal),
    #[error("invalid amount: {0} (at most 2 decimal places allowed)")]
    InvalidAmountPrecision(Decimal),
    #[error("account is already active")]
    AlreadyActive,
    #[error("account is already frozen")]
    AlreadyFrozen,
    #[error("account not found")]
    AccountNotFound,
    #[error("account already exists")]
    AccountAlreadyExists,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Account {
    id: AccountId,
    /// 口座の名義(顧客識別子)。`AccountState`の各バリアントと違い、凍結/解約といった
    /// 状態遷移とは無関係に開設時から不変なので、`id`と同じ扱いで`Account`側に持つ
    /// (`AccountState`には入れない)。振替(同一名義間)/振込(名義不一致)の判定に使う
    /// (docs/adr/0011)。
    owner_id: String,
    state: AccountState,
}

impl Account {
    pub fn open(id: AccountId, owner_id: String, initial_balance: Decimal) -> Self {
        Self {
            id,
            owner_id,
            state: AccountState::Active {
                balance: initial_balance,
            },
        }
    }

    /// 永続化された状態からaggregateを復元する（リポジトリ実装が使う）。
    pub fn rehydrate(id: AccountId, owner_id: String, state: AccountState) -> Self {
        Self { id, owner_id, state }
    }

    pub fn id(&self) -> AccountId {
        self.id
    }

    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }

    pub fn state(&self) -> &AccountState {
        &self.state
    }

    /// まだ口座が存在しない状態に対してコマンドを適用する。
    /// `Command::Open`のみ成功しうる（それ以外は`AccountNotFound`）。
    /// 口座が既に存在する場合の判定は呼び出し側（永続化層）が行い、
    /// 存在する場合は`Account::apply`を使う。
    pub fn apply_to_absent(id: AccountId, cmd: Command, now: OffsetDateTime) -> Result<Event, DomainError> {
        match cmd {
            Command::Open { owner_id, initial_balance } => {
                if initial_balance < Decimal::ZERO {
                    return Err(DomainError::InvalidAmount(initial_balance));
                }
                ensure_at_most_two_decimal_places(initial_balance)?;
                Ok(Event::Opened {
                    account_id: id,
                    owner_id,
                    balance: normalize_amount(initial_balance),
                    opened_at: now,
                })
            }
            Command::Deposit { .. }
            | Command::Withdraw { .. }
            | Command::Freeze { .. }
            | Command::Unfreeze
            | Command::Close => Err(DomainError::AccountNotFound),
        }
    }

    /// コマンドを現在の状態に照らして検証し、受理されれば `Event` を返す。
    /// 状態を直接変更しない（イベントソーシングの decide 相当）。
    pub fn apply(&self, cmd: Command, now: OffsetDateTime) -> Result<Event, DomainError> {
        match &self.state {
            AccountState::Active { balance } => match cmd {
                Command::Open { .. } => Err(DomainError::AccountAlreadyExists),
                Command::Deposit { amount } => {
                    ensure_positive(amount)?;
                    ensure_at_most_two_decimal_places(amount)?;
                    Ok(Event::Deposited {
                        account_id: self.id,
                        amount,
                        // normalize_amountは単に精度超過を丸めるだけでなく、DBラウンドトリップ
                        // 由来のスケールのブレ(例: 保存済みbalanceが900.000000のような形で
                        // 読み戻された場合)や、桁が足りない場合(1000→1000.00)の両方を
                        // 常にちょうど2桁へ揃える。
                        new_balance: normalize_amount(balance + amount),
                    })
                }
                Command::Withdraw { amount } => {
                    ensure_positive(amount)?;
                    ensure_at_most_two_decimal_places(amount)?;
                    if amount > *balance {
                        return Err(DomainError::InsufficientFunds {
                            balance: *balance,
                            requested: amount,
                        });
                    }
                    Ok(Event::Withdrawn {
                        account_id: self.id,
                        amount,
                        new_balance: normalize_amount(balance - amount),
                    })
                }
                Command::Freeze { reason } => Ok(Event::Frozen {
                    account_id: self.id,
                    balance: *balance,
                    reason,
                    frozen_at: now,
                }),
                Command::Unfreeze => Err(DomainError::AlreadyActive),
                Command::Close => Ok(Event::Closed {
                    account_id: self.id,
                    final_balance: *balance,
                    closed_at: now,
                }),
            },
            AccountState::Frozen { balance, reason, .. } => match cmd {
                Command::Open { .. } => Err(DomainError::AccountAlreadyExists),
                Command::Deposit { .. } | Command::Withdraw { .. } => {
                    Err(DomainError::AccountFrozen {
                        reason: reason.clone(),
                    })
                }
                Command::Freeze { .. } => Err(DomainError::AlreadyFrozen),
                Command::Unfreeze => Ok(Event::Unfrozen {
                    account_id: self.id,
                    balance: *balance,
                }),
                Command::Close => Ok(Event::Closed {
                    account_id: self.id,
                    final_balance: *balance,
                    closed_at: now,
                }),
            },
            AccountState::Closed { .. } => match cmd {
                Command::Open { .. } => Err(DomainError::AccountAlreadyExists),
                Command::Deposit { .. }
                | Command::Withdraw { .. }
                | Command::Freeze { .. }
                | Command::Unfreeze
                | Command::Close => Err(DomainError::AccountClosed),
            },
        }
    }

    /// `Event` を状態に畳み込む（イベントソーシングの evolve/fold 相当）。
    /// リプレイ時にはこの関数だけを使って状態を再構築する。
    pub fn evolve(&self, event: &Event) -> Account {
        // owner_idは開設時から不変。`Opened`だけが真実源(コマンドが運んできた値)を持ち、
        // それ以外のイベントは既存の`self.owner_id`をそのまま引き継ぐ。ここもワイルドカード
        // (`_ =>`)を使わず全バリアントを列挙する(CLAUDE.mdの規約通り、新バリアント追加時に
        // ここも強制的にコンパイルエラーにするため)。
        let owner_id = match event {
            Event::Opened { owner_id, .. } => owner_id.clone(),
            Event::Deposited { .. }
            | Event::Withdrawn { .. }
            | Event::Frozen { .. }
            | Event::Unfrozen { .. }
            | Event::Closed { .. } => self.owner_id.clone(),
        };
        let state = match event {
            Event::Opened { balance, .. } => AccountState::Active { balance: *balance },
            Event::Deposited { new_balance, .. } | Event::Withdrawn { new_balance, .. } => {
                AccountState::Active {
                    balance: *new_balance,
                }
            }
            Event::Frozen {
                balance,
                reason,
                frozen_at,
                ..
            } => AccountState::Frozen {
                balance: *balance,
                reason: reason.clone(),
                frozen_at: *frozen_at,
            },
            Event::Unfrozen { balance, .. } => AccountState::Active { balance: *balance },
            Event::Closed {
                final_balance,
                closed_at,
                ..
            } => AccountState::Closed {
                final_balance: *final_balance,
                closed_at: *closed_at,
            },
        };
        Account { id: self.id, owner_id, state }
    }
}

/// 金額(`amount`/`balance`/`initial_balance`)の精度契約: 小数点以下ちょうど2桁まで
/// (docs/adr/0006決定5)。account-domain以外(API Gatewayのリクエスト検証パターン、
/// transfer-serviceのサガ入力検証)もこの値に合わせる——ここが単一の真実源。
pub const AMOUNT_DECIMAL_PLACES: u32 = 2;

fn ensure_positive(amount: Decimal) -> Result<(), DomainError> {
    if amount <= Decimal::ZERO {
        Err(DomainError::InvalidAmount(amount))
    } else {
        Ok(())
    }
}

/// 金額を常にちょうど`AMOUNT_DECIMAL_PLACES`桁に正規化する。`Decimal::round_dp`は精度を
/// 落とす方向にしか働かず、現在の桁数が目標以下ならそのまま返す実装(rust_decimal 1.42.1の
/// `round_dp_with_strategy`: `if old_scale <= dp { return *self; }`)であり、「1000」を
/// 「1000.00」へゼロ埋めしない——これを`round_dp`だけで済むと誤って想定していたことが
/// 実デプロイでの表示不整合(`1000`のまま、`900.000000`は直るが`1000`は2桁にならない)として
/// 露呈した。`Decimal::rescale`は両方向(不足はゼロ埋め、超過は丸め)で厳密に目標スケールへ
/// 揃えるため、精度の強制にはこちらを使う。
fn normalize_amount(mut amount: Decimal) -> Decimal {
    amount.rescale(AMOUNT_DECIMAL_PLACES);
    amount
}

/// DBラウンドトリップ由来のスケールのブレ(例: `900.000000`)を許さない——`scale()`は
/// 値そのものではなく表現上の小数桁数を返すため、`round_dp`で正規化した結果と元の値を
/// 比較するのではなく、`scale()`を直接見て「これ以上細かい表現になっていないか」を判定する。
fn ensure_at_most_two_decimal_places(amount: Decimal) -> Result<(), DomainError> {
    if amount.scale() > AMOUNT_DECIMAL_PLACES {
        Err(DomainError::InvalidAmountPrecision(amount))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn now() -> OffsetDateTime {
        OffsetDateTime::UNIX_EPOCH
    }

    fn owner() -> String {
        "customer-1".to_string()
    }

    #[test]
    fn event_serializes_amount_as_string_not_float() {
        let event = Event::Deposited {
            account_id: AccountId::new(),
            amount: dec!(500.10),
            new_balance: dec!(1500.10),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"500.10\""), "expected amount as JSON string, got: {json}");

        let round_tripped: Event = serde_json::from_str(&json).unwrap();
        assert_eq!(round_tripped, event);
    }

    #[test]
    fn command_round_trips_through_json() {
        let command = Command::Freeze {
            reason: FreezeReason::SuspectedFraud,
        };
        let json = serde_json::to_string(&command).unwrap();
        let round_tripped: Command = serde_json::from_str(&json).unwrap();
        assert_eq!(round_tripped, command);
    }

    #[test]
    fn deposit_increases_balance() {
        let account = Account::open(AccountId::new(), owner(), dec!(1000));
        let event = account.apply(Command::Deposit { amount: dec!(500) }, now()).unwrap();
        assert_eq!(
            event,
            Event::Deposited {
                account_id: account.id(),
                amount: dec!(500),
                new_balance: dec!(1500),
            }
        );
        let account = account.evolve(&event);
        assert_eq!(account.state(), &AccountState::Active { balance: dec!(1500) });
    }

    #[test]
    fn withdraw_more_than_balance_fails() {
        let account = Account::open(AccountId::new(), owner(), dec!(100));
        let err = account
            .apply(Command::Withdraw { amount: dec!(200) }, now())
            .unwrap_err();
        assert_eq!(
            err,
            DomainError::InsufficientFunds {
                balance: dec!(100),
                requested: dec!(200),
            }
        );
    }

    #[test]
    fn deposit_zero_or_negative_is_rejected() {
        let account = Account::open(AccountId::new(), owner(), dec!(100));
        assert_eq!(
            account.apply(Command::Deposit { amount: dec!(0) }, now()).unwrap_err(),
            DomainError::InvalidAmount(dec!(0))
        );
        assert_eq!(
            account
                .apply(Command::Deposit { amount: dec!(-10) }, now())
                .unwrap_err(),
            DomainError::InvalidAmount(dec!(-10))
        );
    }

    #[test]
    fn amounts_with_more_than_two_decimal_places_are_rejected() {
        let account = Account::open(AccountId::new(), owner(), dec!(1000));
        assert_eq!(
            account.apply(Command::Deposit { amount: dec!(10.123) }, now()).unwrap_err(),
            DomainError::InvalidAmountPrecision(dec!(10.123))
        );
        assert_eq!(
            account.apply(Command::Withdraw { amount: dec!(10.001) }, now()).unwrap_err(),
            DomainError::InvalidAmountPrecision(dec!(10.001))
        );
        assert_eq!(
            Account::apply_to_absent(AccountId::new(), Command::Open { owner_id: owner(), initial_balance: dec!(1.005) }, now())
                .unwrap_err(),
            DomainError::InvalidAmountPrecision(dec!(1.005))
        );
    }

    /// docs/adr/0006決定5: 金額は常に小数点以下ちょうど2桁に正規化される。DBラウンドトリップ
    /// 由来のスケールのブレ(実デプロイで発見——保存済みbalanceが`900.000000`のような形で
    /// 読み戻された)が起きても、次にDeposit/Withdrawが適用された時点で自己修復する
    /// (`rescale`)ことをスケールそのもの(`scale()`)で確認する——値の一致だけでは
    /// rust_decimalが`900.000000 == 900`を等価とみなすため、このバグを検知できない。
    #[test]
    fn new_balance_is_normalized_to_two_decimal_places_even_if_the_read_balance_had_drifted_scale() {
        let drifted_balance = dec!(1000.000000);
        assert_eq!(drifted_balance.scale(), 6);
        let account = Account::rehydrate(AccountId::new(), owner(), AccountState::Active { balance: drifted_balance });

        let event = account.apply(Command::Withdraw { amount: dec!(100) }, now()).unwrap();
        let Event::Withdrawn { new_balance, .. } = event else { panic!("expected Withdrawn") };
        assert_eq!(new_balance, dec!(900));
        assert_eq!(new_balance.scale(), 2, "expected exactly 2 decimal places, got scale {}", new_balance.scale());
    }

    /// 逆方向の回帰: 桁が足りない入力(整数の"1000"、scale=0)は、実デプロイで
    /// `Decimal::round_dp`を使っていた際に正規化されず`1000`のまま返っていた(`round_dp`は
    /// `old_scale <= dp`なら値をそのまま返す実装のため)。`rescale`への切り替えでゼロ埋めされ、
    /// 常にちょうど2桁になることを確認する。
    #[test]
    fn balances_with_fewer_than_two_decimal_places_are_padded_to_exactly_two() {
        let initial_balance = dec!(1000);
        assert_eq!(initial_balance.scale(), 0);

        let event =
            Account::apply_to_absent(AccountId::new(), Command::Open { owner_id: owner(), initial_balance }, now()).unwrap();
        let Event::Opened { balance, .. } = event else { panic!("expected Opened") };
        assert_eq!(balance, dec!(1000));
        assert_eq!(balance.scale(), 2, "expected exactly 2 decimal places, got scale {}", balance.scale());

        let account = Account::rehydrate(AccountId::new(), owner(), AccountState::Active { balance });
        let event = account.apply(Command::Deposit { amount: dec!(50) }, now()).unwrap();
        let Event::Deposited { new_balance, .. } = event else { panic!("expected Deposited") };
        assert_eq!(new_balance, dec!(1050));
        assert_eq!(new_balance.scale(), 2, "expected exactly 2 decimal places, got scale {}", new_balance.scale());
    }

    #[test]
    fn frozen_account_rejects_deposit_and_withdraw() {
        let account = Account::open(AccountId::new(), owner(), dec!(100));
        let frozen_event = account
            .apply(
                Command::Freeze {
                    reason: FreezeReason::SuspectedFraud,
                },
                now(),
            )
            .unwrap();
        let account = account.evolve(&frozen_event);

        assert_eq!(
            account.apply(Command::Deposit { amount: dec!(10) }, now()).unwrap_err(),
            DomainError::AccountFrozen {
                reason: FreezeReason::SuspectedFraud
            }
        );
        assert_eq!(
            account.apply(Command::Withdraw { amount: dec!(10) }, now()).unwrap_err(),
            DomainError::AccountFrozen {
                reason: FreezeReason::SuspectedFraud
            }
        );
    }

    #[test]
    fn unfreeze_restores_active_state_with_same_balance() {
        let account = Account::open(AccountId::new(), owner(), dec!(100));
        let frozen_event = account
            .apply(
                Command::Freeze {
                    reason: FreezeReason::CourtOrder,
                },
                now(),
            )
            .unwrap();
        let account = account.evolve(&frozen_event);

        let unfrozen_event = account.apply(Command::Unfreeze, now()).unwrap();
        let account = account.evolve(&unfrozen_event);
        assert_eq!(account.state(), &AccountState::Active { balance: dec!(100) });
    }

    #[test]
    fn unfreeze_on_active_account_fails() {
        let account = Account::open(AccountId::new(), owner(), dec!(100));
        assert_eq!(
            account.apply(Command::Unfreeze, now()).unwrap_err(),
            DomainError::AlreadyActive
        );
    }

    #[test]
    fn closed_account_rejects_all_commands() {
        let account = Account::open(AccountId::new(), owner(), dec!(100));
        let closed_event = account.apply(Command::Close, now()).unwrap();
        let account = account.evolve(&closed_event);

        for cmd in [
            Command::Deposit { amount: dec!(1) },
            Command::Withdraw { amount: dec!(1) },
            Command::Freeze {
                reason: FreezeReason::CustomerRequest,
            },
            Command::Unfreeze,
            Command::Close,
        ] {
            assert_eq!(account.apply(cmd, now()).unwrap_err(), DomainError::AccountClosed);
        }
    }

    #[test]
    fn opening_a_new_account_produces_opened_event() {
        let id = AccountId::new();
        let event = Account::apply_to_absent(id, Command::Open { owner_id: owner(), initial_balance: dec!(100) }, now()).unwrap();
        assert_eq!(
            event,
            Event::Opened {
                account_id: id,
                owner_id: owner(),
                balance: dec!(100),
                opened_at: now(),
            }
        );

        let account = Account::rehydrate(id, owner(), AccountState::Active { balance: dec!(0) }).evolve(&event);
        assert_eq!(account.state(), &AccountState::Active { balance: dec!(100) });
    }

    #[test]
    fn opening_with_negative_initial_balance_is_rejected() {
        let err = Account::apply_to_absent(AccountId::new(), Command::Open { owner_id: owner(), initial_balance: dec!(-1) }, now())
            .unwrap_err();
        assert_eq!(err, DomainError::InvalidAmount(dec!(-1)));
    }

    #[test]
    fn any_command_other_than_open_fails_when_account_is_absent() {
        for cmd in [
            Command::Deposit { amount: dec!(1) },
            Command::Withdraw { amount: dec!(1) },
            Command::Freeze {
                reason: FreezeReason::CustomerRequest,
            },
            Command::Unfreeze,
            Command::Close,
        ] {
            assert_eq!(
                Account::apply_to_absent(AccountId::new(), cmd, now()).unwrap_err(),
                DomainError::AccountNotFound
            );
        }
    }

    #[test]
    fn opening_an_existing_account_fails() {
        let account = Account::open(AccountId::new(), owner(), dec!(100));
        assert_eq!(
            account
                .apply(Command::Open { owner_id: owner(), initial_balance: dec!(50) }, now())
                .unwrap_err(),
            DomainError::AccountAlreadyExists
        );
    }
}

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
    Open { initial_balance: Decimal },
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
    state: AccountState,
}

impl Account {
    pub fn open(id: AccountId, initial_balance: Decimal) -> Self {
        Self {
            id,
            state: AccountState::Active {
                balance: initial_balance,
            },
        }
    }

    /// 永続化された状態からaggregateを復元する（リポジトリ実装が使う）。
    pub fn rehydrate(id: AccountId, state: AccountState) -> Self {
        Self { id, state }
    }

    pub fn id(&self) -> AccountId {
        self.id
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
            Command::Open { initial_balance } => {
                if initial_balance < Decimal::ZERO {
                    return Err(DomainError::InvalidAmount(initial_balance));
                }
                Ok(Event::Opened {
                    account_id: id,
                    balance: initial_balance,
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
                    Ok(Event::Deposited {
                        account_id: self.id,
                        amount,
                        new_balance: balance + amount,
                    })
                }
                Command::Withdraw { amount } => {
                    ensure_positive(amount)?;
                    if amount > *balance {
                        return Err(DomainError::InsufficientFunds {
                            balance: *balance,
                            requested: amount,
                        });
                    }
                    Ok(Event::Withdrawn {
                        account_id: self.id,
                        amount,
                        new_balance: balance - amount,
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
        Account { id: self.id, state }
    }
}

fn ensure_positive(amount: Decimal) -> Result<(), DomainError> {
    if amount <= Decimal::ZERO {
        Err(DomainError::InvalidAmount(amount))
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
        let account = Account::open(AccountId::new(), dec!(1000));
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
        let account = Account::open(AccountId::new(), dec!(100));
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
        let account = Account::open(AccountId::new(), dec!(100));
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
    fn frozen_account_rejects_deposit_and_withdraw() {
        let account = Account::open(AccountId::new(), dec!(100));
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
        let account = Account::open(AccountId::new(), dec!(100));
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
        let account = Account::open(AccountId::new(), dec!(100));
        assert_eq!(
            account.apply(Command::Unfreeze, now()).unwrap_err(),
            DomainError::AlreadyActive
        );
    }

    #[test]
    fn closed_account_rejects_all_commands() {
        let account = Account::open(AccountId::new(), dec!(100));
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
        let event = Account::apply_to_absent(id, Command::Open { initial_balance: dec!(100) }, now()).unwrap();
        assert_eq!(
            event,
            Event::Opened {
                account_id: id,
                balance: dec!(100),
                opened_at: now(),
            }
        );

        let account = Account::rehydrate(id, AccountState::Active { balance: dec!(0) }).evolve(&event);
        assert_eq!(account.state(), &AccountState::Active { balance: dec!(100) });
    }

    #[test]
    fn opening_with_negative_initial_balance_is_rejected() {
        let err = Account::apply_to_absent(AccountId::new(), Command::Open { initial_balance: dec!(-1) }, now())
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
        let account = Account::open(AccountId::new(), dec!(100));
        assert_eq!(
            account
                .apply(Command::Open { initial_balance: dec!(50) }, now())
                .unwrap_err(),
            DomainError::AccountAlreadyExists
        );
    }
}

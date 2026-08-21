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

/// ポイント付与率(docs/adr/0024決定7)。仮の値として送金(受取)額の0.1%とする——
/// `furikomi_max_amount()`と同じPoCスコープの単純化。実運用のポイントプログラム(交換レート、
/// ステージ別料率)を再現するものではない。
/// `amount * Decimal::new(1, 3)`はrust_decimalの乗算規則により、両オペランドのscaleの和
/// (通常2+3=5)をそのまま持ち越す(例: `20000.00 * 0.001` = `20.00000`)——ADR-0025の検証時
/// これ自体は「表示上の見た目」の問題として文字列比較ではなく数値比較でテストを書くことで
/// 済ませていたが、実際にはこの値がそのまま`points-service`の残高として永続化され、後日
/// `fee-service`の`cash_portion`計算に混入し、最終的に`account-service`へ送る`Withdraw`の
/// `amount`が5桁精度になって`DomainError::InvalidAmountPrecision`で機械的に却下される
/// (`AMOUNT_DECIMAL_PLACES`は2桁までしか許さない)という実害のあるバグだった——実際に
/// デモデータ投入(2026-08-19)で、ポイントを獲得した顧客が次の振込でそのポイントを充当
/// しようとした瞬間に発覚した(既存のe2eテストはポイント残高を`seedPointsBalance`で整数の
/// まま直接書き込んでいたため、この経路を一度も実際には通っていなかった)。
/// `account-domain`の`normalize_amount`と同じ`rescale`(不足はゼロ埋め、超過は丸め)で
/// 発生源において2桁へ正規化し、下流(points-serviceの残高・fee-serviceのcash_portion・
/// account-serviceへのWithdraw/Deposit金額)すべてに波及しないようにする。
fn award_points_for(amount: Decimal) -> Decimal {
    let mut points = amount * Decimal::new(1, 3);
    points.rescale(AMOUNT_DECIMAL_PLACES);
    points
}

/// 送金サガの状態。DynamoDBの1アイテム=1サガ(docs/adr/0010決定2)。account-domainの
/// `AccountState`と同じ流儀で、per-variantデータを持つenumとして表現する。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state")]
pub enum SagaState {
    /// 振込の確認待ち。まだaccount-serviceにもfee-serviceにも何も発行していない(docs/adr/0011)。
    PendingConfirmation,
    /// 振込の手数料原資確保待ち(docs/adr/0024)。`fee-service`へ`ReserveFee`を発行し、
    /// `fee.event.FeeReserved`(現金負担分`cash_fee`を伴う)の観測を待っている。振替・組戻しは
    /// この状態を経由しない。
    ReservingFee,
    /// 送金元への`Withdraw`コマンド(送金額+振込なら現金負担分の手数料、docs/adr/0024決定4)を
    /// 発行し、その結果(成功/却下)を待っている。
    PendingDebit,
    /// 出金は成功した。送金先への`Deposit`コマンドを発行し、その結果を待っている。
    PendingCredit,
    /// 入金が却下されたため、送金元へ補償の`Deposit`(送金額+振込なら現金負担分の手数料、
    /// docs/adr/0024決定4)を発行し、その結果を待っている。
    Compensating,
    /// 完了(出金・入金とも成功)。終端状態。
    Credited,
    /// 補償が完了した(送金前と同じ残高に戻った)。終端状態。
    Compensated,
    /// 補償の入金が再送上限を超えて却下され続けたため、銀行所有の仮受金口座へ資金を退避した
    /// (docs/adr/0028)。`Compensated`(正当な持ち主に戻った)とは意図的に区別する終端状態
    /// ——資金は安全だが正当な持ち主にはまだ届いていない、要人手フォローアップの状態。
    SweptToSuspense,
    /// 出金自体が却下された(残高不足等)。まだ何も動いていないため補償は不要。終端状態。
    Failed,
    /// 確認前に取消された。まだ何も動いていないため補償は不要。終端状態(docs/adr/0011)。
    Cancelled,
}

/// account-serviceまたはfee-service/points-serviceから観測した、直前に発行したコマンドの
/// 結果。`account.event.*`(成功)か`account.rejection.*`(却下)かに単純化したもの——具体的に
/// どのイベント種別かはサガの状態(今どのステップを待っているか)から自明なので、サガ自体は
/// それを知る必要がない。`ReservingFee`の観測(`fee.event.FeeReserved`)は成功/却下の2値では
/// なく具体的な内訳データ(`cash_fee`)を伴うため、この型ではなく専用の`reserve_fee_observed`で
/// 扱う(docs/adr/0024決定4)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservedOutcome {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransferSaga {
    /// account-serviceへ発行するコマンドの`correlation_id`と同じ値(docs/adr/0010決定4)。
    /// fee-service/points-serviceへの相関にも同じ値を再利用する(docs/adr/0024決定8)。
    pub transfer_id: String,
    pub from_account_id: Uuid,
    pub to_account_id: Uuid,
    /// 送金元・送金先の名義(docs/adr/0011の口座名義インデックスから`command_intake.rs`が
    /// 解決した値)。`fee-service`/`points-service`はaccount_idではなくowner_id単位で
    /// ポイント/手数料を扱うため(docs/adr/0024決定2)、`command_intake.rs`が振替/振込の判定
    /// のために既に解決済みのこの値をそのまま持たせる。
    pub from_owner_id: String,
    pub to_owner_id: String,
    pub amount: Decimal,
    /// 振込の手数料のうち現金で負担する分(docs/adr/0024決定4)。振替・組戻しでは常に`ZERO`。
    /// `ReservingFee`から`PendingDebit`へ進む際(`reserve_fee_observed`)にのみ設定される。
    pub cash_fee: Decimal,
    /// 振込の手数料のうちポイントで充当した分(docs/adr/0025決定4)。振替・組戻しでは常に
    /// `ZERO`。`cash_fee`と同じタイミング(`reserve_fee_observed`)にのみ設定される——
    /// `fee_amount`(手数料合計)自体はtransfer-serviceが覚える必要はなく、常に
    /// `cash_fee + points_used`として導出できる(`fee-service`が手数料額を所有するという
    /// docs/adr/0024決定2を維持するため、合計額を別途複製して持たない)。
    pub points_used: Decimal,
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
    /// `fee-service`へ手数料の原資確保を依頼する(docs/adr/0024決定4)。`fee_amount`は含まない
    /// ——手数料の金額はfee-serviceの内部ロジックが決める(決定2)。
    IssueReserveFee { transfer_id: String, owner_id: String, account_id: Uuid, transfer_amount: Decimal },
    IssueWithdraw { account_id: Uuid, amount: Decimal },
    IssueDeposit { account_id: Uuid, amount: Decimal },
    IssueCompensatingDeposit { account_id: Uuid, amount: Decimal },
    /// 送金が最終的に失敗/補償された場合の手数料原資の巻き戻し(docs/adr/0024決定5)。
    /// `fee-service`が内部の予約台帳を見て、ポイントが実際に消費されていた場合のみ
    /// `points-service`への返却を行う——`transfer-service`は`points_used`を覚えていない。
    /// 結果を待たないfire-and-forget(docs/adr/0024決定6)。
    IssueRefundFee { transfer_id: String },
    /// 振込の着金確定時にポイントを付与する(docs/adr/0024決定7)。`fee-service`を経由せず
    /// `points-service`へ直接発行する、結果を待たないfire-and-forget。
    IssueAwardPoints { owner_id: String, amount: Decimal },
    /// 補償の入金が再送上限を超えて却下され続けた`Compensating`サガに対し、`sweep_to_suspense`
    /// だけが発行する(docs/adr/0028)。銀行所有の仮受金口座(凍結・解約不能)への退避により、
    /// 資金の所在を必ず確定させる。`saga_step.rs`/`command_intake.rs`はこのバリアントを
    /// 一切発行しない(`bin/saga_watchdog.rs`専用)。
    IssueSuspenseSweepDeposit { account_id: Uuid, amount: Decimal },
    /// 終端状態に達した、確認待ち/取消済みで何も発行していない、または補償自体が却下されて
    /// (`Compensating`のno-op)何も発行していない——後者は`bin/saga_watchdog.rs`が一定時間後に
    /// 再送し(docs/adr/0028)、それでも解決しなければ`sweep_to_suspense`で仮受金口座へ確定させる。
    None,
}

/// 今のサガが待っている「次の一歩」の識別情報。全ステップが同じ`correlation_id`
/// (`transfer_id`)を使う(docs/adr/0010決定4)ため、`correlation_id`が一致するというだけでは
/// 「どのステップの結果か」までは分からない——出金・入金・補償入金・手数料予約はいずれも同じ
/// `correlation_id`を持つ。EventBridgeのat-least-once配信により、既に追い越した古いステップの
/// イベントが後から届くことがあるため、呼び出し側(Lambda glue)は観測したイベントの
/// `account_id`とイベント種別名がこれと一致する場合のみ`advance`/`reserve_fee_observed`を
/// 呼ぶべきで、一致しなければ無関係な(古い/重複した)イベントとして無視しなければならない。
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
/// では`None`——後者はまだaccount-service/fee-serviceに何も発行していないため、そもそも
/// 観測すべきイベントが存在しない。`ReservingFee`は`fee-service`が発行する
/// `fee.event.FeeReserved`を待つ——`account_id`は手数料を負担する送金元口座を使う。
pub fn expected_step(saga: &TransferSaga) -> Option<ExpectedStep> {
    match saga.state {
        SagaState::PendingConfirmation => None,
        SagaState::ReservingFee => Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "FeeReserved" }),
        SagaState::PendingDebit => Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "Withdrawn" }),
        SagaState::PendingCredit => Some(ExpectedStep { account_id: saga.to_account_id, event_variant: "Deposited" }),
        SagaState::Compensating => Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "Deposited" }),
        SagaState::Credited | SagaState::Compensated | SagaState::SweptToSuspense | SagaState::Failed | SagaState::Cancelled => {
            None
        }
    }
}

/// `expected_step`(「何を待っているか」)と対になる、「詰まっている場合に再発行すべき
/// コマンドは何か」のマッピング(docs/adr/0028、`bin/saga_watchdog.rs`が呼ぶ)。新しい
/// ロジックではなく、`confirm`/`reserve_fee_observed`/`advance`が各状態への遷移時に
/// **既に一度計算して発行した`NextAction`と同じもの**を、保存済みの`TransferSaga`(`cash_fee`
/// 等、遷移時点で確定した値を保持している)から再構成するだけ——遷移ロジックの複製ではなく
/// 再現である。`expected_step`が`None`を返す状態(確認待ち・終端状態)では、そもそも
/// 発行すべきコマンドが無いため`NextAction::None`を返す。
pub fn resume_action(saga: &TransferSaga) -> NextAction {
    match saga.state {
        SagaState::PendingConfirmation => NextAction::None,
        SagaState::ReservingFee => NextAction::IssueReserveFee {
            transfer_id: saga.transfer_id.clone(),
            owner_id: saga.from_owner_id.clone(),
            account_id: saga.from_account_id,
            transfer_amount: saga.amount,
        },
        SagaState::PendingDebit => {
            NextAction::IssueWithdraw { account_id: saga.from_account_id, amount: saga.amount + saga.cash_fee }
        }
        SagaState::PendingCredit => NextAction::IssueDeposit { account_id: saga.to_account_id, amount: saga.amount },
        SagaState::Compensating => NextAction::IssueCompensatingDeposit {
            account_id: saga.from_account_id,
            amount: saga.amount + saga.cash_fee,
        },
        SagaState::Credited
        | SagaState::Compensated
        | SagaState::SweptToSuspense
        | SagaState::Failed
        | SagaState::Cancelled => NextAction::None,
    }
}

/// ウォッチドッグの再送上限を超えた`Compensating`サガに対してのみ意味を持つ、銀行所有の
/// 仮受金口座への退避(docs/adr/0028)。`Compensating`以外の状態に対して呼ばれることは
/// `bin/saga_watchdog.rs`の実装上起こらない(呼び出し元が`Compensating`のみを対象にする)が、
/// `SagaState`の全バリアントを明示的に扱う(ワイルドカード禁止の規律、`advance`/
/// `reserve_fee_observed`と同じ)。
pub fn sweep_to_suspense(saga: &TransferSaga, suspense_account_id: Uuid, now: OffsetDateTime) -> (TransferSaga, NextAction) {
    match saga.state {
        SagaState::Compensating => {
            let next = TransferSaga { state: SagaState::SweptToSuspense, updated_at: now, ..saga.clone() };
            let action = NextAction::IssueSuspenseSweepDeposit {
                account_id: suspense_account_id,
                amount: saga.amount + saga.cash_fee,
            };
            (next, action)
        }
        SagaState::PendingConfirmation
        | SagaState::ReservingFee
        | SagaState::PendingDebit
        | SagaState::PendingCredit
        | SagaState::Credited
        | SagaState::Compensated
        | SagaState::SweptToSuspense
        | SagaState::Failed
        | SagaState::Cancelled => (saga.clone(), NextAction::None),
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
/// 名義データソースを知らない。`from_owner_id`/`to_owner_id`も同じ投影から呼び出し側が
/// 既に解決済みの値をそのまま渡す(docs/adr/0024)。
///
/// - `Furikae`/`Recall`は確認不要・手数料もかからず即座に`PendingDebit`へ進み、出金コマンドを
///   発行する。`cash_fee`は常に`ZERO`のまま。
/// - `Furikomi`は`PendingConfirmation`で止まり、何も発行しない。`confirm`が呼ばれるまで
///   account-service/fee-serviceには一切コマンドが送られない(docs/adr/0011、docs/adr/0024)。
#[allow(clippy::too_many_arguments)]
pub fn start(
    transfer_id: String,
    from_account_id: Uuid,
    to_account_id: Uuid,
    from_owner_id: String,
    to_owner_id: String,
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

    let saga = TransferSaga {
        transfer_id,
        from_account_id,
        to_account_id,
        from_owner_id,
        to_owner_id,
        amount,
        cash_fee: Decimal::ZERO,
        points_used: Decimal::ZERO,
        kind,
        state,
        updated_at: now,
    };
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

/// 振込の確認。`PendingConfirmation`のサガのみ受理し、`ReservingFee`へ進めて手数料の原資確保を
/// `fee-service`へ依頼する(docs/adr/0024決定4)——`0011`時点では直接`PendingDebit`へ進んで
/// いたが、手数料の原資を確保してから送金処理を進めるようにこのADRで変更した。
pub fn confirm(saga: &TransferSaga, now: OffsetDateTime) -> Result<(TransferSaga, NextAction), ConfirmError> {
    if saga.state != SagaState::PendingConfirmation {
        return Err(ConfirmError::NotPendingConfirmation);
    }
    let next = TransferSaga { state: SagaState::ReservingFee, updated_at: now, ..saga.clone() };
    let action = NextAction::IssueReserveFee {
        transfer_id: saga.transfer_id.clone(),
        owner_id: saga.from_owner_id.clone(),
        account_id: saga.from_account_id,
        transfer_amount: saga.amount,
    };
    Ok((next, action))
}

/// 振込の取消(確認前のキャンセル)。`PendingConfirmation`のサガのみ受理し、`Cancelled`へ
/// 進める。まだ何もaccount-service/fee-serviceに発行していないため、これ以上のアクションはない
/// (docs/adr/0011)。
pub fn cancel(saga: &TransferSaga, now: OffsetDateTime) -> Result<(TransferSaga, NextAction), CancelError> {
    if saga.state != SagaState::PendingConfirmation {
        return Err(CancelError::NotPendingConfirmation);
    }
    let next = TransferSaga { state: SagaState::Cancelled, updated_at: now, ..saga.clone() };
    Ok((next, NextAction::None))
}

/// `fee-service`からの`fee.event.FeeReserved`観測(現金負担分`cash_fee`を伴う)を受けて
/// `ReservingFee`から`PendingDebit`へ進める(docs/adr/0024決定4)。`ObservedOutcome`の2値では
/// なく具体的な内訳データを伴うため、`advance`とは別関数にする——`fee-service`は原資確保を
/// 拒否しない設計(決定3)なので却下という結果は存在しない。
///
/// `ReservingFee`以外の状態に対して呼ばれること自体、通常は起こらない(`expected_step`が
/// この状態でのみ`"FeeReserved"`を返すため観測ロジックの対象にならない)が、`advance`と同じく
/// `SagaState`の全バリアントを明示的に扱う(ワイルドドなし)——万一の呼び出しに備えて安全側に
/// 倒す。
pub fn reserve_fee_observed(saga: &TransferSaga, cash_fee: Decimal, points_used: Decimal, now: OffsetDateTime) -> (TransferSaga, NextAction) {
    match saga.state {
        SagaState::ReservingFee => {
            let next = TransferSaga { state: SagaState::PendingDebit, cash_fee, points_used, updated_at: now, ..saga.clone() };
            let action = NextAction::IssueWithdraw { account_id: saga.from_account_id, amount: saga.amount + cash_fee };
            (next, action)
        }
        SagaState::PendingConfirmation
        | SagaState::PendingDebit
        | SagaState::PendingCredit
        | SagaState::Compensating
        | SagaState::Credited
        | SagaState::Compensated
        | SagaState::SweptToSuspense
        | SagaState::Failed
        | SagaState::Cancelled => (saga.clone(), NextAction::None),
    }
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
/// `PendingConfirmation`/`ReservingFee`(前者はまだ何も発行しておらず、後者は`fee.event.FeeReserved`
/// を`reserve_fee_observed`が別途処理する)は、以後どんな観測結果が来ても状態を変えないno-op
/// ——万一の呼び出しに備えて安全側に倒す。
pub fn advance(saga: &TransferSaga, observed: ObservedOutcome) -> (SagaState, NextAction) {
    match saga.state {
        SagaState::PendingConfirmation => (SagaState::PendingConfirmation, NextAction::None),
        SagaState::ReservingFee => (SagaState::ReservingFee, NextAction::None),
        SagaState::PendingDebit => match observed {
            ObservedOutcome::Accepted => (
                SagaState::PendingCredit,
                NextAction::IssueDeposit { account_id: saga.to_account_id, amount: saga.amount },
            ),
            // 出金自体が却下された場合、振込であれば手数料の原資(ポイント消費分)を巻き戻す
            // (docs/adr/0024決定5)。振替・組戻しはそもそも手数料を予約していないため何もしない。
            ObservedOutcome::Rejected => {
                let refund = if saga.kind == TransferKind::Furikomi {
                    NextAction::IssueRefundFee { transfer_id: saga.transfer_id.clone() }
                } else {
                    NextAction::None
                };
                (SagaState::Failed, refund)
            }
        },
        SagaState::PendingCredit => match observed {
            // 着金確定時、振込であればポイントを付与する(docs/adr/0024決定7)。
            ObservedOutcome::Accepted => {
                let award = if saga.kind == TransferKind::Furikomi {
                    NextAction::IssueAwardPoints { owner_id: saga.to_owner_id.clone(), amount: award_points_for(saga.amount) }
                } else {
                    NextAction::None
                };
                (SagaState::Credited, award)
            }
            // 入金が却下された場合の補償は、送金額+振込なら現金負担分の手数料を送金元へ返す
            // (docs/adr/0024決定4)——手数料自体の返却(ポイント分)は決定5の通り、
            // Compensating完了時にまとめて行う。
            ObservedOutcome::Rejected => (
                SagaState::Compensating,
                NextAction::IssueCompensatingDeposit { account_id: saga.from_account_id, amount: saga.amount + saga.cash_fee },
            ),
        },
        SagaState::Compensating => match observed {
            // 補償の入金が確定した時点で、振込であれば手数料の原資(ポイント消費分)を巻き戻す
            // (docs/adr/0024決定5)。
            ObservedOutcome::Accepted => {
                let refund = if saga.kind == TransferKind::Furikomi {
                    NextAction::IssueRefundFee { transfer_id: saga.transfer_id.clone() }
                } else {
                    NextAction::None
                };
                (SagaState::Compensated, refund)
            }
            // 補償自体の却下は状態を変えず滞留させる——`bin/saga_watchdog.rs`(docs/adr/0028)が
            // 一定時間後に`resume_action`で同じ補償入金を再送し、それでも解決しなければ
            // `sweep_to_suspense`で銀行所有の仮受金口座へ確定的に退避する。
            ObservedOutcome::Rejected => (SagaState::Compensating, NextAction::None),
        },
        SagaState::Credited
        | SagaState::Compensated
        | SagaState::SweptToSuspense
        | SagaState::Failed
        | SagaState::Cancelled => (saga.state.clone(), NextAction::None),
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
            from_owner_id: "owner-from".to_string(),
            to_owner_id: "owner-to".to_string(),
            amount: dec!(100),
            cash_fee: dec!(0),
            points_used: dec!(0),
            kind,
            state,
            updated_at: now(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn start_with_owners(
        transfer_id: &str,
        from: Uuid,
        to: Uuid,
        amount: Decimal,
        kind: TransferKind,
    ) -> Result<(TransferSaga, NextAction), StartError> {
        start(transfer_id.to_string(), from, to, "owner-from".to_string(), "owner-to".to_string(), amount, kind, now())
    }

    #[test]
    fn start_furikae_produces_pending_debit_and_issues_withdraw_from_the_source_account() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        let (saga, action) = start_with_owners("transfer-1", from, to, dec!(500), TransferKind::Furikae).unwrap();
        assert_eq!(saga.state, SagaState::PendingDebit);
        assert_eq!(saga.kind, TransferKind::Furikae);
        assert_eq!(saga.cash_fee, dec!(0));
        assert_eq!(action, NextAction::IssueWithdraw { account_id: from, amount: dec!(500) });
    }

    #[test]
    fn start_recall_behaves_like_furikae_no_confirmation_required() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        let (saga, action) = start_with_owners("recall-1", from, to, dec!(500), TransferKind::Recall).unwrap();
        assert_eq!(saga.state, SagaState::PendingDebit);
        assert_eq!(action, NextAction::IssueWithdraw { account_id: from, amount: dec!(500) });
    }

    #[test]
    fn start_furikomi_stops_at_pending_confirmation_and_issues_nothing() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        let (saga, action) = start_with_owners("transfer-1", from, to, dec!(500), TransferKind::Furikomi).unwrap();
        assert_eq!(saga.state, SagaState::PendingConfirmation);
        assert_eq!(saga.kind, TransferKind::Furikomi);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn start_furikomi_exceeding_the_limit_is_rejected() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        assert_eq!(
            start_with_owners("t", from, to, dec!(1000000.01), TransferKind::Furikomi),
            Err(StartError::ExceedsFurikomiLimit)
        );
        // ちょうど上限額は許可される。
        assert!(start_with_owners("t", from, to, dec!(1000000), TransferKind::Furikomi).is_ok());
    }

    #[test]
    fn start_furikae_is_not_subject_to_the_furikomi_limit() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        assert!(start_with_owners("t", from, to, dec!(5000000), TransferKind::Furikae).is_ok());
    }

    #[test]
    fn start_rejects_non_positive_amounts() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        assert_eq!(start_with_owners("t", from, to, dec!(0), TransferKind::Furikae), Err(StartError::NonPositiveAmount));
        assert_eq!(start_with_owners("t", from, to, dec!(-1), TransferKind::Furikae), Err(StartError::NonPositiveAmount));
    }

    #[test]
    fn start_rejects_amounts_with_more_than_two_decimal_places() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        assert_eq!(
            start_with_owners("t", from, to, dec!(10.123), TransferKind::Furikae),
            Err(StartError::InvalidAmountPrecision)
        );
        // ちょうど2桁は許可される。
        assert!(start_with_owners("t", from, to, dec!(10.12), TransferKind::Furikae).is_ok());
    }

    #[test]
    fn start_rejects_transfers_to_the_same_account() {
        let account = Uuid::new_v4();
        assert_eq!(
            start_with_owners("t", account, account, dec!(500), TransferKind::Furikae),
            Err(StartError::SameAccount)
        );
    }

    #[test]
    fn confirm_moves_pending_confirmation_to_reserving_fee_and_requests_a_fee_reservation() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::PendingConfirmation);
        let (next, action) = confirm(&saga, now()).unwrap();
        assert_eq!(next.state, SagaState::ReservingFee);
        assert_eq!(
            action,
            NextAction::IssueReserveFee {
                transfer_id: saga.transfer_id.clone(),
                owner_id: saga.from_owner_id.clone(),
                account_id: saga.from_account_id,
                transfer_amount: saga.amount,
            }
        );
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
    fn reserve_fee_observed_moves_reserving_fee_to_pending_debit_and_bundles_the_cash_portion() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::ReservingFee);
        let (next, action) = reserve_fee_observed(&saga, dec!(140), dec!(80), now());
        assert_eq!(next.state, SagaState::PendingDebit);
        assert_eq!(next.cash_fee, dec!(140));
        assert_eq!(next.points_used, dec!(80));
        assert_eq!(action, NextAction::IssueWithdraw { account_id: saga.from_account_id, amount: dec!(240) });
    }

    #[test]
    fn reserve_fee_observed_with_zero_cash_fee_still_withdraws_just_the_transfer_amount() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::ReservingFee);
        let (next, action) = reserve_fee_observed(&saga, dec!(0), dec!(220), now());
        assert_eq!(next.cash_fee, dec!(0));
        assert_eq!(next.points_used, dec!(220));
        assert_eq!(action, NextAction::IssueWithdraw { account_id: saga.from_account_id, amount: dec!(100) });
    }

    #[test]
    fn reserve_fee_observed_is_a_defensive_no_op_outside_reserving_fee() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::PendingDebit);
        let (next, action) = reserve_fee_observed(&saga, dec!(140), dec!(80), now());
        assert_eq!(next, saga);
        assert_eq!(action, NextAction::None);
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
            SagaState::ReservingFee,
            SagaState::PendingDebit,
            SagaState::PendingCredit,
            SagaState::Compensating,
            SagaState::Compensated,
            SagaState::SweptToSuspense,
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
    fn withdraw_rejected_fails_the_saga_without_compensation_for_furikae() {
        let saga = saga_in(TransferKind::Furikae, SagaState::PendingDebit);
        let (next, action) = advance(&saga, ObservedOutcome::Rejected);
        assert_eq!(next, SagaState::Failed);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn withdraw_rejected_for_furikomi_refunds_the_fee_reservation() {
        let mut saga = saga_in(TransferKind::Furikomi, SagaState::PendingDebit);
        saga.cash_fee = dec!(140);
        let (next, action) = advance(&saga, ObservedOutcome::Rejected);
        assert_eq!(next, SagaState::Failed);
        assert_eq!(action, NextAction::IssueRefundFee { transfer_id: saga.transfer_id.clone() });
    }

    #[test]
    fn deposit_accepted_completes_the_saga_without_awarding_points_for_furikae() {
        let saga = saga_in(TransferKind::Furikae, SagaState::PendingCredit);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::Credited);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn deposit_accepted_for_furikomi_awards_points_to_the_recipient() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::PendingCredit);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::Credited);
        assert_eq!(action, NextAction::IssueAwardPoints { owner_id: saga.to_owner_id.clone(), amount: dec!(0.1) });
    }

    /// 実デプロイで発見した回帰(2026-08-19、デモデータ投入時): `amount * Decimal::new(1, 3)`は
    /// rust_decimalの乗算規則でscaleを持ち越す(`20000.00 * 0.001` = `20.00000`、5桁)。この値が
    /// そのままpoints-serviceの残高として永続化され、後日その顧客が別の振込の手数料へ充当した
    /// 際にfee-serviceのcash_portion計算経由でaccount-serviceへのWithdraw金額に混入し、
    /// `DomainError::InvalidAmountPrecision`(2桁まで、`AMOUNT_DECIMAL_PLACES`)で機械的に
    /// 却下されるという実害があった。`award_points_for`の戻り値が常に2桁以下であることを
    /// 直接固定する。
    #[test]
    fn award_points_for_never_exceeds_two_decimal_places_even_when_the_multiplication_would_carry_more_scale() {
        let saga = TransferSaga { amount: dec!(20000.00), ..saga_in(TransferKind::Furikomi, SagaState::PendingCredit) };
        let (_, action) = advance(&saga, ObservedOutcome::Accepted);
        let NextAction::IssueAwardPoints { amount, .. } = action else { panic!("expected IssueAwardPoints") };
        assert!(amount.scale() <= AMOUNT_DECIMAL_PLACES, "amount {amount} has scale {}", amount.scale());
        assert_eq!(amount, dec!(20));
    }

    #[test]
    fn deposit_rejected_triggers_compensation_including_the_cash_fee_back_to_the_source_account() {
        let mut saga = saga_in(TransferKind::Furikomi, SagaState::PendingCredit);
        saga.cash_fee = dec!(140);
        let (next, action) = advance(&saga, ObservedOutcome::Rejected);
        assert_eq!(next, SagaState::Compensating);
        assert_eq!(
            action,
            NextAction::IssueCompensatingDeposit { account_id: saga.from_account_id, amount: dec!(240) }
        );
    }

    #[test]
    fn compensating_deposit_accepted_completes_compensation_without_fee_refund_for_furikae() {
        let saga = saga_in(TransferKind::Furikae, SagaState::Compensating);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::Compensated);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn compensating_deposit_accepted_for_furikomi_refunds_the_fee_reservation() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::Compensating);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::Compensated);
        assert_eq!(action, NextAction::IssueRefundFee { transfer_id: saga.transfer_id.clone() });
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
    fn reserving_fee_ignores_advance_as_a_defensive_no_op() {
        // ReservingFeeの実際の遷移はreserve_fee_observedが専用に扱う(FeeReservedはfee-serviceが
        // 拒否しない設計のため、ObservedOutcome::Rejectedがここに届くこと自体、通常は起こらない)。
        let saga = saga_in(TransferKind::Furikomi, SagaState::ReservingFee);
        let (next, action) = advance(&saga, ObservedOutcome::Accepted);
        assert_eq!(next, SagaState::ReservingFee);
        assert_eq!(action, NextAction::None);
    }

    #[test]
    fn expected_step_tracks_which_account_and_event_variant_the_saga_is_currently_waiting_on() {
        let saga = saga_in(TransferKind::Furikomi, SagaState::ReservingFee);
        assert_eq!(
            expected_step(&saga),
            Some(ExpectedStep { account_id: saga.from_account_id, event_variant: "FeeReserved" })
        );

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

    // docs/adr/0028: resume_actionは新しいロジックではなく、各遷移関数が元々発行した
    // NextActionと同じものを保存済みのサガから再構成するだけ——ここでは、実際に遷移関数を
    // 呼んで得られるNextActionと、resume_actionが同じ状態に対して返すNextActionが一致する
    // ことを直接突き合わせて検証する。
    #[test]
    fn resume_action_reconstructs_the_same_next_action_confirm_would_issue_for_reserving_fee() {
        let pending = saga_in(TransferKind::Furikomi, SagaState::PendingConfirmation);
        let (reserving, confirm_action) = confirm(&pending, now()).unwrap();
        assert_eq!(reserving.state, SagaState::ReservingFee);
        assert_eq!(resume_action(&reserving), confirm_action);
    }

    #[test]
    fn resume_action_reconstructs_the_same_next_action_reserve_fee_observed_would_issue_for_pending_debit() {
        let reserving = saga_in(TransferKind::Furikomi, SagaState::ReservingFee);
        let (pending_debit, observed_action) = reserve_fee_observed(&reserving, dec!(20), dec!(0), now());
        assert_eq!(pending_debit.state, SagaState::PendingDebit);
        assert_eq!(resume_action(&pending_debit), observed_action);
    }

    #[test]
    fn resume_action_reconstructs_the_same_next_action_advance_would_issue_for_pending_credit() {
        let pending_debit = saga_in(TransferKind::Furikae, SagaState::PendingDebit);
        let (pending_credit, advance_action) = advance(&pending_debit, ObservedOutcome::Accepted);
        assert_eq!(pending_credit, SagaState::PendingCredit);
        let saga = TransferSaga { state: pending_credit, ..pending_debit };
        assert_eq!(resume_action(&saga), advance_action);
    }

    #[test]
    fn resume_action_reconstructs_the_same_next_action_advance_would_issue_for_compensating() {
        let pending_credit = TransferSaga { cash_fee: dec!(20), ..saga_in(TransferKind::Furikomi, SagaState::PendingCredit) };
        let (compensating, advance_action) = advance(&pending_credit, ObservedOutcome::Rejected);
        assert_eq!(compensating, SagaState::Compensating);
        let saga = TransferSaga { state: compensating, ..pending_credit };
        assert_eq!(resume_action(&saga), advance_action);
    }

    #[test]
    fn resume_action_is_none_for_terminal_states_and_pending_confirmation() {
        for state in [
            SagaState::Credited,
            SagaState::Compensated,
            SagaState::SweptToSuspense,
            SagaState::Failed,
            SagaState::Cancelled,
            SagaState::PendingConfirmation,
        ] {
            assert_eq!(resume_action(&saga_in(TransferKind::Furikomi, state)), NextAction::None);
        }
    }

    // docs/adr/0028決定(仮受金口座への退避)。
    #[test]
    fn sweep_to_suspense_moves_compensating_to_swept_and_issues_a_deposit_to_the_suspense_account() {
        let saga = TransferSaga { cash_fee: dec!(20), ..saga_in(TransferKind::Furikomi, SagaState::Compensating) };
        let suspense_account_id = Uuid::new_v4();
        let (next, action) = sweep_to_suspense(&saga, suspense_account_id, now());
        assert_eq!(next.state, SagaState::SweptToSuspense);
        // 送金額+現金負担分の手数料——本来Compensatingが送金元へ返そうとしていたのと同じ金額
        // (resume_actionのCompensating分岐と同じ計算)を、宛先だけ差し替えて仮受金口座へ送る。
        assert_eq!(action, NextAction::IssueSuspenseSweepDeposit { account_id: suspense_account_id, amount: dec!(120) });
    }

    #[test]
    fn sweep_to_suspense_is_a_defensive_no_op_outside_compensating() {
        let suspense_account_id = Uuid::new_v4();
        for state in [
            SagaState::PendingConfirmation,
            SagaState::ReservingFee,
            SagaState::PendingDebit,
            SagaState::PendingCredit,
            SagaState::Credited,
            SagaState::Compensated,
            SagaState::SweptToSuspense,
            SagaState::Failed,
            SagaState::Cancelled,
        ] {
            let saga = saga_in(TransferKind::Furikomi, state.clone());
            let (next, action) = sweep_to_suspense(&saga, suspense_account_id, now());
            assert_eq!(next.state, state);
            assert_eq!(action, NextAction::None);
        }
    }
}

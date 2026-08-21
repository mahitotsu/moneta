// スケジュール駆動(EventBridge Rule、レート指定)のLambda(docs/adr/0028)。ADR-0010決定6が
// 「compensatingのまま滞留するケースへの対応は本ADRのスコープ外(自動リトライは設計しない)」
// としていたのを、実際にイベント駆動の枠内(既存パターンの延長)で解決する。
//
// `saga_step.rs`(イベント駆動)・`command_intake.rs`(SQS駆動)と違い、こちらはタイマー駆動——
// 「一定時間、期待していたイベントが来ない」という不在を検知できるのはタイマーだけであり、
// イベント購読では原理的に検知できない(何も届かないことを購読で検知することはできない)。
use account_domain::{OffsetDateTime, Uuid};
use aws_sdk_cloudwatch::types::{Dimension, MetricDatum, StandardUnit};
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde_json::Value;
use time::Duration;
use transfer_service::saga::{resume_action, sweep_to_suspense, NextAction, SagaState, TransferSaga};
use transfer_service::{commands, persistence};
use transfer_service::persistence::StuckSaga;

/// サガが「詰まっている」と判断するまでの猶予。通常の結果整合性の窓(アウトボックス経由、
/// 最大約1分)より十分長く取り、「コマンドは成功したが結果イベントの反映がまだ」という
/// 正常な遅延を誤って再送しないようにする(docs/adr/0028の安全性分析)。
const STUCK_THRESHOLD: Duration = Duration::minutes(10);

/// この回数まで自動再送を試み、それでも解消しなければ運用アラートへ切り替える——ADR-0010が
/// 最初に構想していた「運用上のアラート・手動対応」を、今回初めて実装する形。
const MAX_WATCHDOG_RETRIES: u32 = 3;

/// `resume_action`が意味を持つ4状態(`expected_step`がSomeを返す状態と同じ集合)。確認待ち
/// (`PendingConfirmation`)・終端状態はそもそも何も発行していない、または発行し終えているため
/// 対象外。
const WATCHDOG_STATES: [SagaState; 4] =
    [SagaState::ReservingFee, SagaState::PendingDebit, SagaState::PendingCredit, SagaState::Compensating];

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let saga_table_name = std::env::var("SAGA_TABLE_NAME").expect("SAGA_TABLE_NAME environment variable must be set");
    let account_command_queue_url =
        std::env::var("ACCOUNT_COMMAND_QUEUE_URL").expect("ACCOUNT_COMMAND_QUEUE_URL environment variable must be set");
    let fee_command_queue_url =
        std::env::var("FEE_COMMAND_QUEUE_URL").expect("FEE_COMMAND_QUEUE_URL environment variable must be set");
    // docs/adr/0028: 銀行所有の仮受金口座(凍結・解約不能、infra/scripts/setup-suspense-account.ts
    // が一度だけ開設する)。`Compensating`が再送上限を超えても解決しない場合の確定的な退避先。
    let suspense_account_id = Uuid::parse_str(
        &std::env::var("SUSPENSE_ACCOUNT_ID").expect("SUSPENSE_ACCOUNT_ID environment variable must be set"),
    )
    .expect("SUSPENSE_ACCOUNT_ID must be a valid UUID");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = aws_sdk_dynamodb::Client::new(&aws_config);
    let sqs = aws_sdk_sqs::Client::new(&aws_config);
    let cloudwatch = aws_sdk_cloudwatch::Client::new(&aws_config);

    // イベントの中身は使わない——EventBridgeのスケジュールイベント・手動invoke(api-e2eの
    // テスト用ヘルパー)のどちらでも動くよう、任意のJSONを受け付ける。
    run(service_fn(move |_event: LambdaEvent<Value>| {
        let dynamodb = dynamodb.clone();
        let sqs = sqs.clone();
        let cloudwatch = cloudwatch.clone();
        let saga_table_name = saga_table_name.clone();
        let account_command_queue_url = account_command_queue_url.clone();
        let fee_command_queue_url = fee_command_queue_url.clone();
        async move {
            sweep(
                &dynamodb,
                &sqs,
                &cloudwatch,
                &saga_table_name,
                &account_command_queue_url,
                &fee_command_queue_url,
                suspense_account_id,
            )
            .await
        }
    }))
    .await
}

async fn sweep(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    cloudwatch: &aws_sdk_cloudwatch::Client,
    saga_table_name: &str,
    account_command_queue_url: &str,
    fee_command_queue_url: &str,
    suspense_account_id: Uuid,
) -> Result<(), Error> {
    let now = OffsetDateTime::now_utc();
    let older_than = now - STUCK_THRESHOLD;
    let stuck = persistence::scan_stuck_sagas(dynamodb, saga_table_name, &WATCHDOG_STATES, older_than).await?;
    tracing::info!(count = stuck.len(), "found stuck saga candidates");

    for candidate in stuck {
        if candidate.retry_count < MAX_WATCHDOG_RETRIES {
            retry(dynamodb, sqs, saga_table_name, account_command_queue_url, fee_command_queue_url, &candidate, now)
                .await?;
        } else if candidate.saga.state == SagaState::Compensating {
            // docs/adr/0028: `Compensating`だけは「同じ補償入金を銀行所有の仮受金口座宛てに
            // 差し替えて確定させる」という安全な自動フォールバックを持つ(補償の入金先だけを
            // 差し替えるだけで、"誰にいくら返すべきか"という判断自体は変わらない)。
            sweep_stuck_compensation(
                dynamodb,
                sqs,
                cloudwatch,
                saga_table_name,
                account_command_queue_url,
                suspense_account_id,
                &candidate,
                now,
            )
            .await?;
        } else {
            // `ReservingFee`/`PendingDebit`/`PendingCredit`には同種の安全なフォールバックが
            // 無い(お金がどこにあるか自体が未確定なため、機械的に確定させられない)——引き続き
            // 運用者への通知に留める。
            escalate(cloudwatch, &candidate.saga).await?;
        }
    }
    Ok(())
}

/// 再送上限を超えた`Compensating`サガを、銀行所有の仮受金口座への入金に差し替えて
/// `SweptToSuspense`(終端)へ確定させる(docs/adr/0028)。仮受金口座は構造的に凍結・解約
/// されない(docs/adr/0016の所有者検証、`owner_id`が実在のCognito subと一致し得ない)ため、
/// この入金は(このシステムが実際にさらす障害モードの範囲では)確実に成功する前提で、
/// `RefundFee`/`AwardPoints`(docs/adr/0024決定6)と同じくfire-and-forgetとして扱い、
/// 発行と同時に終端状態へ倒す。
#[allow(clippy::too_many_arguments)]
async fn sweep_stuck_compensation(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    cloudwatch: &aws_sdk_cloudwatch::Client,
    saga_table_name: &str,
    account_command_queue_url: &str,
    suspense_account_id: Uuid,
    candidate: &StuckSaga,
    now: OffsetDateTime,
) -> Result<(), Error> {
    let saga = &candidate.saga;
    let (_, action) = sweep_to_suspense(saga, suspense_account_id, now);
    issue_sweep_action(sqs, account_command_queue_url, &saga.transfer_id, action).await?;

    let swept = persistence::advance_saga_state(
        dynamodb,
        saga_table_name,
        &saga.transfer_id,
        &SagaState::Compensating,
        &SagaState::SweptToSuspense,
        now,
    )
    .await?;
    if swept {
        tracing::error!(
            transfer_id = %saga.transfer_id,
            "compensation retries exhausted; swept to the bank-owned suspense account for manual follow-up",
        );
        cloudwatch
            .put_metric_data()
            .namespace("Moneta/TransferSaga")
            .metric_data(MetricDatum::builder().metric_name("SagaSweptToSuspense").value(1.0).unit(StandardUnit::Count).build())
            .send()
            .await?;
    } else {
        tracing::info!(transfer_id = %saga.transfer_id, "saga resolved before the suspense sweep could apply; skipping");
    }
    Ok(())
}

/// 詰まっているサガへコマンドを再発行する。スキャンからここに至るまでの間にサガが通常の
/// 観測経路で自然に先へ進んでいた場合は、`record_watchdog_retry`のCASが不成立になり
/// 何もしない(docs/adr/0028)。
async fn retry(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    saga_table_name: &str,
    account_command_queue_url: &str,
    fee_command_queue_url: &str,
    candidate: &StuckSaga,
    now: OffsetDateTime,
) -> Result<(), Error> {
    let saga = &candidate.saga;
    let action = resume_action(saga);
    // docs/adr/0028: attemptにcandidate.retry_count(単調増加)を埋め込み、再送のたびに
    // MessageDeduplicationIdを変える——固定キーのままだとSQS FIFOの5分間の重複排除窓の中に
    // 収まる再送が黙って握りつぶされ、account-service/fee-serviceに一度も配信されない
    // (commands.rsの当該コメント参照、実機検証で発見した実バグ)。
    issue_retry_action(
        sqs,
        account_command_queue_url,
        fee_command_queue_url,
        &saga.transfer_id,
        candidate.retry_count,
        action,
    )
    .await?;

    let recorded =
        persistence::record_watchdog_retry(dynamodb, saga_table_name, &saga.transfer_id, &saga.state, saga.updated_at, now)
            .await?;
    if recorded {
        tracing::warn!(
            transfer_id = %saga.transfer_id,
            retry_count = candidate.retry_count + 1,
            state = state_label(&saga.state),
            "resent command for a stuck saga",
        );
    } else {
        tracing::info!(transfer_id = %saga.transfer_id, "saga advanced between scan and retry; skipping this cycle");
    }
    Ok(())
}

/// `resume_action`が返しうる4つの再送可能バリアント(`IssueReserveFee`/`IssueWithdraw`/
/// `IssueDeposit`/`IssueCompensatingDeposit`)を扱う。`commands.rs`の`_retry`suffix付き
/// ヘルパー(`attempt`ごとに`MessageDeduplicationId`を変える、docs/adr/0028)を使う——
/// 通常の`send_*`(固定キー)をそのまま流用すると、短い間隔での複数回再送がSQS FIFOの
/// 重複排除窓に飲まれて一度も配信されない実バグを踏む。`IssueSuspenseSweepDeposit`は
/// `sweep_to_suspense`だけが返す(`resume_action`は返さない)ため`unreachable!()`。
async fn issue_retry_action(
    sqs: &aws_sdk_sqs::Client,
    account_command_queue_url: &str,
    fee_command_queue_url: &str,
    transfer_id: &str,
    attempt: u32,
    action: NextAction,
) -> Result<(), Error> {
    match action {
        NextAction::IssueReserveFee { transfer_id, owner_id, account_id, transfer_amount } => {
            commands::send_reserve_fee_retry(
                sqs,
                fee_command_queue_url,
                &transfer_id,
                &owner_id,
                account_id,
                transfer_amount,
                attempt,
            )
            .await?;
        }
        NextAction::IssueWithdraw { account_id, amount } => {
            commands::send_withdraw_retry(sqs, account_command_queue_url, account_id, amount, transfer_id, attempt).await?;
        }
        NextAction::IssueDeposit { account_id, amount } => {
            commands::send_deposit_retry(sqs, account_command_queue_url, account_id, amount, transfer_id, attempt).await?;
        }
        NextAction::IssueCompensatingDeposit { account_id, amount } => {
            commands::send_compensating_deposit_retry(sqs, account_command_queue_url, account_id, amount, transfer_id, attempt)
                .await?;
        }
        NextAction::IssueSuspenseSweepDeposit { .. } => {
            unreachable!("IssueSuspenseSweepDeposit is only ever returned by sweep_to_suspense, never resume_action")
        }
        // fire-and-forgetの返却・付与系(docs/adr/0024決定6)はサガの状態遷移をブロックしない
        // ため、`resume_action`が対象にする4状態(`expected_step`がSomeを返す状態)からは
        // 発生しない組み合わせ——それでも`NextAction`の全バリアントを網羅する(ワイルドカード
        // 禁止の規律、saga.rsの`advance`/`reserve_fee_observed`と同じ扱い)。
        NextAction::IssueRefundFee { .. } | NextAction::IssueAwardPoints { .. } | NextAction::None => {}
    }
    Ok(())
}

/// `sweep_to_suspense`が返す`IssueSuspenseSweepDeposit`だけを扱う。この退避は再送上限に
/// 達した時点で1回だけ発行する終端アクションのため、`send_suspense_sweep_deposit`
/// (固定`MessageDeduplicationId`)で十分——`issue_retry_action`と違い複数回発行されうる
/// 心配はない。
async fn issue_sweep_action(
    sqs: &aws_sdk_sqs::Client,
    account_command_queue_url: &str,
    transfer_id: &str,
    action: NextAction,
) -> Result<(), Error> {
    match action {
        NextAction::IssueSuspenseSweepDeposit { account_id, amount } => {
            commands::send_suspense_sweep_deposit(sqs, account_command_queue_url, account_id, amount, transfer_id).await?;
        }
        NextAction::None => {}
        NextAction::IssueReserveFee { .. }
        | NextAction::IssueWithdraw { .. }
        | NextAction::IssueDeposit { .. }
        | NextAction::IssueCompensatingDeposit { .. }
        | NextAction::IssueRefundFee { .. }
        | NextAction::IssueAwardPoints { .. } => {
            unreachable!("sweep_to_suspense only ever returns IssueSuspenseSweepDeposit or None")
        }
    }
    Ok(())
}

/// 再送の上限に達したサガを、運用者が気付けるようCloudWatchカスタムメトリクスとして発行する
/// (docs/adr/0028、`infra/lib/account-pipeline-stack.ts`の`StuckSagaEscalated`アラームが
/// これを監視する)。O1(DLQアラーム)と同じ「メッセージ単位ではなく業務単位の異常を運用者に
/// 見せる」考え方をサガのレベルに適用したもの。
async fn escalate(cloudwatch: &aws_sdk_cloudwatch::Client, saga: &TransferSaga) -> Result<(), Error> {
    tracing::error!(
        transfer_id = %saga.transfer_id,
        state = state_label(&saga.state),
        "saga exceeded max watchdog retries; escalating for operator attention",
    );
    cloudwatch
        .put_metric_data()
        .namespace("Moneta/TransferSaga")
        .metric_data(
            MetricDatum::builder()
                .metric_name("StuckSagaEscalated")
                .dimensions(Dimension::builder().name("State").value(state_label(&saga.state)).build())
                .value(1.0)
                .unit(StandardUnit::Count)
                .build(),
        )
        .send()
        .await?;
    Ok(())
}

fn state_label(state: &SagaState) -> &'static str {
    match state {
        SagaState::PendingConfirmation => "PendingConfirmation",
        SagaState::ReservingFee => "ReservingFee",
        SagaState::PendingDebit => "PendingDebit",
        SagaState::PendingCredit => "PendingCredit",
        SagaState::Compensating => "Compensating",
        SagaState::Credited => "Credited",
        SagaState::Compensated => "Compensated",
        SagaState::SweptToSuspense => "SweptToSuspense",
        SagaState::Failed => "Failed",
        SagaState::Cancelled => "Cancelled",
    }
}

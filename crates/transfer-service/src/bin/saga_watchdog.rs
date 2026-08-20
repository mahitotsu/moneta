// スケジュール駆動(EventBridge Rule、レート指定)のLambda(docs/adr/0028)。ADR-0010決定6が
// 「compensatingのまま滞留するケースへの対応は本ADRのスコープ外(自動リトライは設計しない)」
// としていたのを、実際にイベント駆動の枠内(既存パターンの延長)で解決する。
//
// `saga_step.rs`(イベント駆動)・`command_intake.rs`(SQS駆動)と違い、こちらはタイマー駆動——
// 「一定時間、期待していたイベントが来ない」という不在を検知できるのはタイマーだけであり、
// イベント購読では原理的に検知できない(何も届かないことを購読で検知することはできない)。
use account_domain::OffsetDateTime;
use aws_sdk_cloudwatch::types::{Dimension, MetricDatum, StandardUnit};
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde_json::Value;
use time::Duration;
use transfer_service::saga::{resume_action, NextAction, SagaState, TransferSaga};
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
            sweep(&dynamodb, &sqs, &cloudwatch, &saga_table_name, &account_command_queue_url, &fee_command_queue_url)
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
) -> Result<(), Error> {
    let now = OffsetDateTime::now_utc();
    let older_than = now - STUCK_THRESHOLD;
    let stuck = persistence::scan_stuck_sagas(dynamodb, saga_table_name, &WATCHDOG_STATES, older_than).await?;
    tracing::info!(count = stuck.len(), "found stuck saga candidates");

    for candidate in stuck {
        if candidate.retry_count >= MAX_WATCHDOG_RETRIES {
            escalate(cloudwatch, &candidate.saga).await?;
        } else {
            retry(dynamodb, sqs, saga_table_name, account_command_queue_url, fee_command_queue_url, &candidate, now)
                .await?;
        }
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
    issue_action(sqs, account_command_queue_url, fee_command_queue_url, &saga.transfer_id, action).await?;

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

/// `resume_action`が返しうる全バリアントを扱う。`saga_step.rs`/`command_intake.rs`の各分岐は
/// 「この呼び出し元は特定のNextActionしか受け取らない」という前提でunreachable!()にできる
/// 変種を持つが、ここは「どの状態で詰まっていたか」次第でどの`Issue*`も来うるため、
/// unreachable!()にできる変種は無い。
async fn issue_action(
    sqs: &aws_sdk_sqs::Client,
    account_command_queue_url: &str,
    fee_command_queue_url: &str,
    transfer_id: &str,
    action: NextAction,
) -> Result<(), Error> {
    match action {
        NextAction::IssueReserveFee { transfer_id, owner_id, account_id, transfer_amount } => {
            commands::send_reserve_fee(sqs, fee_command_queue_url, &transfer_id, &owner_id, account_id, transfer_amount)
                .await?;
        }
        NextAction::IssueWithdraw { account_id, amount } => {
            commands::send_withdraw(sqs, account_command_queue_url, account_id, amount, transfer_id).await?;
        }
        NextAction::IssueDeposit { account_id, amount } => {
            commands::send_deposit(sqs, account_command_queue_url, account_id, amount, transfer_id).await?;
        }
        NextAction::IssueCompensatingDeposit { account_id, amount } => {
            commands::send_compensating_deposit(sqs, account_command_queue_url, account_id, amount, transfer_id).await?;
        }
        // fire-and-forgetの返却・付与系(docs/adr/0024決定6)はサガの状態遷移をブロックしない
        // ため、`resume_action`が対象にする4状態(`expected_step`がSomeを返す状態)からは
        // 発生しない組み合わせ——それでも`NextAction`の全バリアントを網羅する(ワイルドカード
        // 禁止の規律、saga.rsの`advance`/`reserve_fee_observed`と同じ扱い)。
        NextAction::IssueRefundFee { .. } | NextAction::IssueAwardPoints { .. } | NextAction::None => {}
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
        SagaState::Failed => "Failed",
        SagaState::Cancelled => "Cancelled",
    }
}

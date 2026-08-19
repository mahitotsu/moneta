use account_domain::{Decimal, EventEnvelope, OffsetDateTime};
use aws_lambda_events::eventbridge::EventBridgeEvent;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde_json::Value;
use std::str::FromStr;
use transfer_service::saga::{advance, expected_step, reserve_fee_observed, NextAction, ObservedOutcome, SagaState};
use transfer_service::{commands, persistence};

const EVENT_KIND: &str = "event";
const REJECTION_KIND: &str = "rejection";

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let saga_table_name = std::env::var("SAGA_TABLE_NAME").expect("SAGA_TABLE_NAME environment variable must be set");
    let account_command_queue_url =
        std::env::var("ACCOUNT_COMMAND_QUEUE_URL").expect("ACCOUNT_COMMAND_QUEUE_URL environment variable must be set");
    // docs/adr/0024決定8: fee-service/points-service宛のコマンドキュー。`advance()`が
    // `IssueRefundFee`/`IssueAwardPoints`を返したときにだけ使う。
    let fee_command_queue_url =
        std::env::var("FEE_COMMAND_QUEUE_URL").expect("FEE_COMMAND_QUEUE_URL environment variable must be set");
    let points_command_queue_url =
        std::env::var("POINTS_COMMAND_QUEUE_URL").expect("POINTS_COMMAND_QUEUE_URL environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = aws_sdk_dynamodb::Client::new(&aws_config);
    let sqs = aws_sdk_sqs::Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<EventBridgeEvent<EventEnvelope>>| {
        let dynamodb = dynamodb.clone();
        let sqs = sqs.clone();
        let saga_table_name = saga_table_name.clone();
        let account_command_queue_url = account_command_queue_url.clone();
        let fee_command_queue_url = fee_command_queue_url.clone();
        let points_command_queue_url = points_command_queue_url.clone();
        async move {
            step_one(
                &dynamodb,
                &sqs,
                &saga_table_name,
                &account_command_queue_url,
                &fee_command_queue_url,
                &points_command_queue_url,
                event.payload.detail,
            )
            .await
        }
    }))
    .await
}

/// account-domainのEvent/DomainErrorはserdeのデフォルト(外部タグ)表現でシリアライズされる:
/// unitバリアントはJSON文字列、それ以外はキーが1つのオブジェクト(account-serviceの
/// outbox.rsの`variant_name`と同じロジック——コード共有はしていない。理由はcommands.rsの
/// コメントを参照)。fee-serviceの`fee.event.FeeReserved`も同じ形で発行する(docs/adr/0024決定8)。
fn variant_name(payload: &Value) -> String {
    match payload {
        Value::String(name) => name.clone(),
        Value::Object(map) => map.keys().next().cloned().unwrap_or_else(|| "unknown".to_string()),
        _ => "unknown".to_string(),
    }
}

/// `fee.event.FeeReserved`のペイロード(`{"FeeReserved": {"cash_portion": "140", "points_used": "80"}}`)
/// から`cash_portion`/`points_used`を取り出す。形が想定と違う場合は`None`(呼び出し側が防御的に
/// 無視する)。
fn extract_cash_portion(payload: &Value) -> Option<Decimal> {
    payload.get("FeeReserved")?.get("cash_portion")?.as_str().and_then(|s| Decimal::from_str(s).ok())
}

fn extract_points_used(payload: &Value) -> Option<Decimal> {
    payload.get("FeeReserved")?.get("points_used")?.as_str().and_then(|s| Decimal::from_str(s).ok())
}

#[allow(clippy::too_many_arguments)]
async fn step_one(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    saga_table_name: &str,
    account_command_queue_url: &str,
    fee_command_queue_url: &str,
    points_command_queue_url: &str,
    envelope: EventEnvelope,
) -> Result<(), Error> {
    let Some(transfer_id) = envelope.correlation_id.clone() else {
        // EventBridge Rule側で`correlation_id`が存在するイベントだけに絞っているはずだが、
        // Query Serviceの`project_one`同様、購読条件だけに依存させない境界での防御チェック。
        tracing::warn!("ignoring envelope without correlation_id");
        return Ok(());
    };

    let Some(saga) = persistence::load_saga(dynamodb, saga_table_name, &transfer_id).await? else {
        tracing::warn!(%transfer_id, "no saga found for correlation_id; ignoring");
        return Ok(());
    };

    let Some(expected) = expected_step(&saga) else {
        // 既に終端状態。at-least-once配信による重複か、追い越された古いイベント。
        tracing::info!(%transfer_id, ?saga.state, "saga already in a terminal state; ignoring event");
        return Ok(());
    };

    let observed_outcome = match envelope.kind.as_str() {
        EVENT_KIND => ObservedOutcome::Accepted,
        REJECTION_KIND => ObservedOutcome::Rejected,
        other => {
            tracing::warn!(%transfer_id, kind = other, "ignoring envelope with unknown kind");
            return Ok(());
        }
    };

    // 今待っているステップと一致しない(口座が違う、またはイベント種別が違う)場合は、
    // 追い越された古いステップの重複配信として無視する(docs/adr/0010、saga.rsの
    // `expected_step`のドキュメント参照)。rejectionはDomainErrorのどのバリアントでも
    // 「却下された」という事実で十分なので、event_variantの突き合わせは"event"のときだけ行う。
    let variant = variant_name(&envelope.data);
    let matches_expected_step = envelope.account_id == expected.account_id
        && (observed_outcome == ObservedOutcome::Rejected || variant == expected.event_variant);
    if !matches_expected_step {
        tracing::info!(
            %transfer_id,
            account_id = %envelope.account_id,
            variant,
            expected_account_id = %expected.account_id,
            expected_variant = expected.event_variant,
            "event doesn't match the step this saga is currently waiting on; ignoring as stale/duplicate"
        );
        return Ok(());
    }

    // `ReservingFee`だけは`advance`(成功/却下の2値)ではなく`reserve_fee_observed`
    // (具体的な`cash_portion`を伴う)で扱う(docs/adr/0024決定4)。fee-serviceは原資確保を
    // 拒否しない設計(決定3)のため、ここに"rejection"が届くこと自体、通常は起こらない——
    // 万一届いても状態を進めず無視する。
    if saga.state == SagaState::ReservingFee {
        let accepted = observed_outcome == ObservedOutcome::Accepted;
        let Some((cash_portion, points_used)) = accepted
            .then(|| extract_cash_portion(&envelope.data).zip(extract_points_used(&envelope.data)))
            .flatten()
        else {
            tracing::warn!(%transfer_id, ?observed_outcome, "unexpected fee reservation outcome; fee-service should never reject a reservation (docs/adr/0024決定3); ignoring");
            return Ok(());
        };

        let (_, action) = reserve_fee_observed(&saga, cash_portion, points_used, OffsetDateTime::now_utc());
        let advanced = persistence::advance_saga_to_pending_debit_with_fee(
            dynamodb,
            saga_table_name,
            &transfer_id,
            cash_portion,
            points_used,
            OffsetDateTime::now_utc(),
        )
        .await?;
        if !advanced {
            tracing::info!(%transfer_id, "saga state already advanced by a concurrent/duplicate delivery; not issuing a command");
            return Ok(());
        }

        return issue_action(sqs, account_command_queue_url, fee_command_queue_url, points_command_queue_url, &transfer_id, action)
            .await;
    }

    let (next_state, action) = advance(&saga, observed_outcome);

    // 状態遷移を先にCAS(楽観的並行性制御)でコミットし、成功した場合のみ次のコマンドを
    // 発行する。逆順(先に発行してから状態を書く)だと、同じイベントが並行して2回処理された
    // 際に同じコマンドを2回発行しうる——CASで「この遷移を行う権利」を獲得した1回の実行だけが
    // 発行する、という単一化の役割をDynamoDB側の条件付き書き込みに持たせている。
    let advanced =
        persistence::advance_saga_state(dynamodb, saga_table_name, &transfer_id, &saga.state, &next_state, OffsetDateTime::now_utc())
            .await?;
    if !advanced {
        tracing::info!(%transfer_id, "saga state already advanced by a concurrent/duplicate delivery; not issuing a command");
        return Ok(());
    }

    issue_action(sqs, account_command_queue_url, fee_command_queue_url, points_command_queue_url, &transfer_id, action).await
}

async fn issue_action(
    sqs: &aws_sdk_sqs::Client,
    account_command_queue_url: &str,
    fee_command_queue_url: &str,
    points_command_queue_url: &str,
    transfer_id: &str,
    action: NextAction,
) -> Result<(), Error> {
    match action {
        // docs/adr/0024決定4: `reserve_fee_observed`(ReservingFee→PendingDebit)は
        // `IssueWithdraw`を返す——旧コード(0011まで)ではWithdrawは`start()`/`confirm()`
        // からしか発行されなかったが、手数料の原資確保後にPendingDebitへ進むこの経路が
        // 新たに加わったため、ここでも扱う必要がある(実デプロイで発見: この分岐を
        // `unreachable!()`のまま残していたためpanicしていた)。
        NextAction::IssueWithdraw { account_id, amount } => {
            commands::send_withdraw(sqs, account_command_queue_url, account_id, amount, transfer_id).await?;
        }
        NextAction::IssueDeposit { account_id, amount } => {
            commands::send_deposit(sqs, account_command_queue_url, account_id, amount, transfer_id).await?;
        }
        NextAction::IssueCompensatingDeposit { account_id, amount } => {
            commands::send_compensating_deposit(sqs, account_command_queue_url, account_id, amount, transfer_id).await?;
        }
        NextAction::IssueRefundFee { transfer_id } => {
            commands::send_refund_fee(sqs, fee_command_queue_url, &transfer_id).await?;
        }
        NextAction::IssueAwardPoints { owner_id, amount } => {
            commands::send_award_points(sqs, points_command_queue_url, transfer_id, &owner_id, amount).await?;
        }
        NextAction::IssueReserveFee { .. } => {
            unreachable!("IssueReserveFee is only ever returned by confirm(), handled in command_intake.rs")
        }
        NextAction::None => {}
    }

    Ok(())
}

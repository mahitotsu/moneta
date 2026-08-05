use account_domain::EventEnvelope;
use aws_lambda_events::eventbridge::EventBridgeEvent;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde_json::Value;
use transfer_service::saga::{advance, expected_step, NextAction, ObservedOutcome};
use transfer_service::{commands, persistence};

const EVENT_KIND: &str = "event";
const REJECTION_KIND: &str = "rejection";

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let saga_table_name = std::env::var("SAGA_TABLE_NAME").expect("SAGA_TABLE_NAME environment variable must be set");
    let account_command_queue_url =
        std::env::var("ACCOUNT_COMMAND_QUEUE_URL").expect("ACCOUNT_COMMAND_QUEUE_URL environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = aws_sdk_dynamodb::Client::new(&aws_config);
    let sqs = aws_sdk_sqs::Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<EventBridgeEvent<EventEnvelope>>| {
        let dynamodb = dynamodb.clone();
        let sqs = sqs.clone();
        let saga_table_name = saga_table_name.clone();
        let account_command_queue_url = account_command_queue_url.clone();
        async move { step_one(&dynamodb, &sqs, &saga_table_name, &account_command_queue_url, event.payload.detail).await }
    }))
    .await
}

/// account-domainのEvent/DomainErrorはserdeのデフォルト(外部タグ)表現でシリアライズされる:
/// unitバリアントはJSON文字列、それ以外はキーが1つのオブジェクト(account-serviceの
/// outbox.rsの`variant_name`と同じロジック——コード共有はしていない。理由はcommands.rsの
/// コメントを参照)。
fn variant_name(payload: &Value) -> String {
    match payload {
        Value::String(name) => name.clone(),
        Value::Object(map) => map.keys().next().cloned().unwrap_or_else(|| "unknown".to_string()),
        _ => "unknown".to_string(),
    }
}

async fn step_one(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    saga_table_name: &str,
    account_command_queue_url: &str,
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

    let (next_state, action) = advance(&saga, observed_outcome);

    // 状態遷移を先にCAS(楽観的並行性制御)でコミットし、成功した場合のみ次のコマンドを
    // 発行する。逆順(先に発行してから状態を書く)だと、同じイベントが並行して2回処理された
    // 際に同じコマンドを2回発行しうる——CASで「この遷移を行う権利」を獲得した1回の実行だけが
    // 発行する、という単一化の役割をDynamoDB側の条件付き書き込みに持たせている。
    let advanced = persistence::advance_saga_state(dynamodb, saga_table_name, &transfer_id, &saga.state, &next_state).await?;
    if !advanced {
        tracing::info!(%transfer_id, "saga state already advanced by a concurrent/duplicate delivery; not issuing a command");
        return Ok(());
    }

    match action {
        NextAction::IssueWithdraw { .. } => {
            unreachable!("advance() never issues a fresh Withdraw; that only happens in start()")
        }
        NextAction::IssueDeposit { account_id, amount } => {
            commands::send_deposit(sqs, account_command_queue_url, account_id, amount, &transfer_id).await?;
        }
        NextAction::IssueCompensatingDeposit { account_id, amount } => {
            commands::send_compensating_deposit(sqs, account_command_queue_url, account_id, amount, &transfer_id).await?;
        }
        NextAction::None => {}
    }

    Ok(())
}

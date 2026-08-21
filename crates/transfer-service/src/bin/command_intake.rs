use account_domain::{Decimal, OffsetDateTime, Uuid};
use aws_lambda_events::sqs::{SqsBatchResponse, SqsEvent};
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::Deserialize;
use transfer_service::saga::{
    cancel, confirm, recall_eligibility, start, CancelError, ConfirmError, NextAction, RecallError, StartError,
    TransferKind,
};
use transfer_service::{commands, persistence};

/// Transfer受付キュー(`moneta-transfer-commands-main.fifo`)へ送るメッセージ本文。
/// account-domainの`Command`と同じ流儀(serdeのデフォルト外部タグ付け)で、1メッセージ=
/// 1アクションを表す(docs/adr/0011)。`transfer_id`はクライアント生成のサガID
/// (account-serviceのクライアント生成口座IDと同じ考え方、docs/adr/0006決定2)。
#[derive(Debug, Deserialize)]
enum TransferCommand {
    /// 新しい送金を開始する。振替(同一名義間)か振込(名義不一致)かはこのLambdaが
    /// 口座名義インデックスを引いてサーバ側で判定する——クライアントは申告しない。
    Start { transfer_id: String, from_account_id: Uuid, to_account_id: Uuid, amount: Decimal },
    /// 振込(`PendingConfirmation`)の確認。振替には存在しない操作(振替は確認不要で即座に
    /// 開始されるため、確認待ちの状態自体を経由しない)。
    Confirm { transfer_id: String },
    /// 振込(`PendingConfirmation`)の取消。
    Cancel { transfer_id: String },
    /// 組戻し。`original_transfer_id`が指す完了済み振込を条件付きで取り消す
    /// (`recall_eligibility`)。`transfer_id`は組戻し自身の新しいサガID。
    Recall { transfer_id: String, original_transfer_id: String },
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let saga_table_name = std::env::var("SAGA_TABLE_NAME").expect("SAGA_TABLE_NAME environment variable must be set");
    let owner_table_name = std::env::var("OWNER_TABLE_NAME").expect("OWNER_TABLE_NAME environment variable must be set");
    let account_command_queue_url =
        std::env::var("ACCOUNT_COMMAND_QUEUE_URL").expect("ACCOUNT_COMMAND_QUEUE_URL environment variable must be set");
    // docs/adr/0024決定8: fee-service宛のコマンドキュー。`ReservingFee`に入る際
    // (`confirm`)にのみ使う——`points-service`への直接発行(AwardPoints)は別のキューを使う。
    let fee_command_queue_url =
        std::env::var("FEE_COMMAND_QUEUE_URL").expect("FEE_COMMAND_QUEUE_URL environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = aws_sdk_dynamodb::Client::new(&aws_config);
    let sqs = aws_sdk_sqs::Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<SqsEvent>| {
        let dynamodb = dynamodb.clone();
        let sqs = sqs.clone();
        let saga_table_name = saga_table_name.clone();
        let owner_table_name = owner_table_name.clone();
        let account_command_queue_url = account_command_queue_url.clone();
        let fee_command_queue_url = fee_command_queue_url.clone();
        async move {
            process_batch(
                &dynamodb,
                &sqs,
                &saga_table_name,
                &owner_table_name,
                &account_command_queue_url,
                &fee_command_queue_url,
                event.payload,
            )
            .await
        }
    }))
    .await
}

/// 各メッセージは独立したサガ操作要求であり、他のメッセージとの順序依存が無いため
/// (account-serviceのように同一aggregateへの直列化が必要な操作ではない)、account-service
/// のgrouping.rs/batch.rsのようなグループ単位の失敗スコープは不要——メッセージ単位で
/// 独立に成否を報告するだけでよい。
#[allow(clippy::too_many_arguments)]
async fn process_batch(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    saga_table_name: &str,
    owner_table_name: &str,
    account_command_queue_url: &str,
    fee_command_queue_url: &str,
    event: SqsEvent,
) -> Result<SqsBatchResponse, Error> {
    let mut failed_message_ids = Vec::new();

    for record in event.records {
        let Some(message_id) = record.message_id.clone() else { continue };
        let body = record.body.as_deref().unwrap_or_default();

        match process_one(dynamodb, sqs, saga_table_name, owner_table_name, account_command_queue_url, fee_command_queue_url, body)
            .await
        {
            Ok(()) => {}
            // 決定論的に確定した拒否はaccount-domainのDomainErrorと同じ扱い:
            // リトライしても結果は変わらないためSQSには失敗として報告しない(docs/adr/0002
            // 決定1と同じ考え方)。
            Err(ProcessError::Start(reason)) => {
                tracing::warn!(%message_id, ?reason, "transfer start rejected; not retrying");
            }
            Err(ProcessError::Confirm(reason)) => {
                tracing::warn!(%message_id, ?reason, "transfer confirm rejected; not retrying");
            }
            Err(ProcessError::Cancel(reason)) => {
                tracing::warn!(%message_id, ?reason, "transfer cancel rejected; not retrying");
            }
            Err(ProcessError::Recall(reason)) => {
                tracing::warn!(%message_id, ?reason, "transfer recall rejected; not retrying");
            }
            Err(ProcessError::SagaNotFound(transfer_id)) => {
                tracing::warn!(%message_id, %transfer_id, "referenced transfer_id has no saga; not retrying");
            }
            Err(ProcessError::Infra(err)) => {
                tracing::error!(%message_id, %err, "infra failure processing transfer command; will be retried");
                failed_message_ids.push(message_id);
            }
        }
    }

    let mut response = SqsBatchResponse::default();
    response.set_failures(failed_message_ids);
    Ok(response)
}

enum ProcessError {
    Start(StartError),
    Confirm(ConfirmError),
    Cancel(CancelError),
    Recall(RecallError),
    /// `Confirm`/`Cancel`/`Recall`が参照した`transfer_id`に対応するサガが見つからない
    /// (存在しない、または誤ったID)。決定論的な拒否として扱う——再試行しても見つからない。
    SagaNotFound(String),
    Infra(Error),
}

impl From<aws_sdk_dynamodb::Error> for ProcessError {
    fn from(err: aws_sdk_dynamodb::Error) -> Self {
        ProcessError::Infra(err.into())
    }
}

impl From<aws_sdk_sqs::Error> for ProcessError {
    fn from(err: aws_sdk_sqs::Error) -> Self {
        ProcessError::Infra(err.into())
    }
}

#[allow(clippy::too_many_arguments)]
async fn process_one(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    saga_table_name: &str,
    owner_table_name: &str,
    account_command_queue_url: &str,
    fee_command_queue_url: &str,
    body: &str,
) -> Result<(), ProcessError> {
    let command: TransferCommand = serde_json::from_str(body).map_err(|err| ProcessError::Infra(err.into()))?;

    match command {
        TransferCommand::Start { transfer_id, from_account_id, to_account_id, amount } => {
            process_start(dynamodb, sqs, saga_table_name, owner_table_name, account_command_queue_url, transfer_id, from_account_id, to_account_id, amount)
                .await
        }
        TransferCommand::Confirm { transfer_id } => {
            process_confirm(dynamodb, sqs, saga_table_name, fee_command_queue_url, transfer_id).await
        }
        TransferCommand::Cancel { transfer_id } => process_cancel(dynamodb, saga_table_name, transfer_id).await,
        TransferCommand::Recall { transfer_id, original_transfer_id } => {
            process_recall(dynamodb, sqs, saga_table_name, account_command_queue_url, transfer_id, original_transfer_id).await
        }
    }
}

/// 振替(同一名義間)/振込(名義不一致)の判定は、口座名義インデックス(`owner_projector.rs`が
/// `account.event.Opened`から投影)をこのLambdaが引いて行う——クライアント申告ではなく
/// サーバ側の真実に基づく(docs/adr/0011)。
///
/// どちらかの口座の名義がまだ見つからない場合は却下ではなく`ProcessError::Infra`として
/// SQSに再配信させる:口座作成イベントがこの投影にまだ反映されていないだけの結果整合性の
/// 遅延である可能性があり、これを恒久的な失敗と即断しない([[eventual_consistency_not_a_failure]]
/// と同じ考え方)。存在しない口座IDを指定した場合も同様に扱われ、最終的にはDLQへ積まれて
/// 運用側の検知に委ねる——両者を区別する手段(account-serviceへの直接照会)は本ADRのスコープ外。
#[allow(clippy::too_many_arguments)]
async fn process_start(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    saga_table_name: &str,
    owner_table_name: &str,
    account_command_queue_url: &str,
    transfer_id: String,
    from_account_id: Uuid,
    to_account_id: Uuid,
    amount: Decimal,
) -> Result<(), ProcessError> {
    let owner_from = persistence::load_owner(dynamodb, owner_table_name, from_account_id).await?;
    let owner_to = persistence::load_owner(dynamodb, owner_table_name, to_account_id).await?;
    let (Some(owner_from), Some(owner_to)) = (owner_from, owner_to) else {
        return Err(ProcessError::Infra(
            format!("owner not yet indexed for from={from_account_id} or to={to_account_id}; will retry").into(),
        ));
    };
    let kind = if owner_from == owner_to { TransferKind::Furikae } else { TransferKind::Furikomi };

    let now = OffsetDateTime::now_utc();
    let (saga, action) =
        start(transfer_id, from_account_id, to_account_id, owner_from, owner_to, amount, kind, now)
            .map_err(ProcessError::Start)?;

    let created = persistence::create_new_saga(dynamodb, saga_table_name, &saga).await?;
    if !created {
        // 既に存在する = at-least-once配信による重複。最初の配信で既に必要なコマンドを
        // 発行済みのはずなので、ここでは何もしない(冪等)。
        tracing::info!(transfer_id = %saga.transfer_id, "duplicate transfer request; already started");
        return Ok(());
    }

    issue_start_action(sqs, account_command_queue_url, &saga.transfer_id, action).await
}

async fn process_confirm(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    saga_table_name: &str,
    fee_command_queue_url: &str,
    transfer_id: String,
) -> Result<(), ProcessError> {
    let saga = persistence::load_saga(dynamodb, saga_table_name, &transfer_id)
        .await?
        .ok_or_else(|| ProcessError::SagaNotFound(transfer_id.clone()))?;

    let now = OffsetDateTime::now_utc();
    let (next, action) = confirm(&saga, now).map_err(ProcessError::Confirm)?;

    let advanced =
        persistence::advance_saga_state(dynamodb, saga_table_name, &transfer_id, &saga.state, &next.state, now).await?;
    if !advanced {
        tracing::info!(%transfer_id, "saga already advanced by a concurrent/duplicate delivery; not issuing a command");
        return Ok(());
    }

    // confirm()が返しうるのはIssueReserveFeeだけ(docs/adr/0024決定4)。
    match action {
        NextAction::IssueReserveFee { transfer_id, owner_id, account_id, transfer_amount } => {
            commands::send_reserve_fee(sqs, fee_command_queue_url, &transfer_id, &owner_id, account_id, transfer_amount)
                .await?;
        }
        other => unreachable!("confirm() only ever returns IssueReserveFee, got {other:?}"),
    }
    Ok(())
}

async fn process_cancel(
    dynamodb: &aws_sdk_dynamodb::Client,
    saga_table_name: &str,
    transfer_id: String,
) -> Result<(), ProcessError> {
    let saga = persistence::load_saga(dynamodb, saga_table_name, &transfer_id)
        .await?
        .ok_or_else(|| ProcessError::SagaNotFound(transfer_id.clone()))?;

    let now = OffsetDateTime::now_utc();
    let (next, _action) = cancel(&saga, now).map_err(ProcessError::Cancel)?;

    // cancel()のNextActionは常にNone(何も発行しない)なので、CASの成否に関わらずここで
    // 行うことは無い。CAS自体は「取消が確定した」という事実を記録するために必要。
    persistence::advance_saga_state(dynamodb, saga_table_name, &transfer_id, &saga.state, &next.state, now).await?;
    Ok(())
}

async fn process_recall(
    dynamodb: &aws_sdk_dynamodb::Client,
    sqs: &aws_sdk_sqs::Client,
    saga_table_name: &str,
    account_command_queue_url: &str,
    transfer_id: String,
    original_transfer_id: String,
) -> Result<(), ProcessError> {
    let original = persistence::load_saga(dynamodb, saga_table_name, &original_transfer_id)
        .await?
        .ok_or_else(|| ProcessError::SagaNotFound(original_transfer_id.clone()))?;

    let now = OffsetDateTime::now_utc();
    recall_eligibility(&original, now).map_err(ProcessError::Recall)?;

    // 組戻しは「新しい`kind = Recall`のサガとしてstart()を再利用する」設計(docs/adr/0011)——
    // 新しい終端状態は追加しない。受取人側の出金がDomainError::InsufficientFunds等で却下
    // された場合は、通常のPendingDebit+却下→Failedの経路がそのまま「組戻し失敗」を表現する。
    // 組戻しには手数料がかからない(docs/adr/0024決定2)ため、名義は素通しするだけで
    // fee-serviceには一切関与させない。
    let (saga, action) = start(
        transfer_id,
        original.to_account_id,
        original.from_account_id,
        original.to_owner_id.clone(),
        original.from_owner_id.clone(),
        original.amount,
        TransferKind::Recall,
        now,
    )
    .map_err(ProcessError::Start)?;

    let created = persistence::create_new_saga(dynamodb, saga_table_name, &saga).await?;
    if !created {
        tracing::info!(transfer_id = %saga.transfer_id, "duplicate recall request; already started");
        return Ok(());
    }

    issue_start_action(sqs, account_command_queue_url, &saga.transfer_id, action).await
}

/// `start`が返す`NextAction`は`IssueWithdraw`か`None`のいずれかにしかなりえない
/// (振込は`PendingConfirmation`+`None`、振替/組戻しは`PendingDebit`+`IssueWithdraw`、
/// saga.rs参照)。`confirm()`が返す`IssueReserveFee`は`process_confirm`が別途扱う。
async fn issue_start_action(
    sqs: &aws_sdk_sqs::Client,
    account_command_queue_url: &str,
    transfer_id: &str,
    action: NextAction,
) -> Result<(), ProcessError> {
    match action {
        NextAction::IssueWithdraw { account_id, amount } => {
            commands::send_withdraw(sqs, account_command_queue_url, account_id, amount, transfer_id).await?;
        }
        NextAction::None => {}
        NextAction::IssueDeposit { .. }
        | NextAction::IssueCompensatingDeposit { .. }
        | NextAction::IssueReserveFee { .. }
        | NextAction::IssueRefundFee { .. }
        | NextAction::IssueAwardPoints { .. }
        | NextAction::IssueSuspenseSweepDeposit { .. } => {
            unreachable!("start() only ever returns IssueWithdraw or None")
        }
    }
    Ok(())
}

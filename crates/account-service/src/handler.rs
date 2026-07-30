use aurora_dsql_sqlx_connector::OCCRetryExt;
use aws_lambda_events::sqs::{SqsBatchResponse, SqsEvent, SqsMessage};
use lambda_runtime::{Error, LambdaEvent};
use sqlx::PgPool;

use crate::batch::failed_message_ids_from;
use crate::grouping::group_by_message_group_id;
use crate::persistence::{self, AccountCommandEnvelope};

pub async fn function_handler(
    event: LambdaEvent<SqsEvent>,
    pool: PgPool,
) -> Result<SqsBatchResponse, Error> {
    let groups = group_by_message_group_id(event.payload.records);
    let mut failed_message_ids = Vec::new();

    for (message_group_id, messages) in groups {
        if let Some(failed_from) = process_group(&pool, &message_group_id, &messages).await {
            failed_message_ids.extend(failed_message_ids_from(&messages, failed_from));
        }
    }

    let mut response = SqsBatchResponse::default();
    response.set_failures(failed_message_ids);
    Ok(response)
}

/// 1つのMessageGroupId（= aggregate root ID）に属するメッセージ列を、
/// メッセージ1件につき1つのDSQLトランザクションとして順番に適用する
/// （docs/adr/0002 決定2）。
///
/// あるメッセージでインフラ起因の失敗（OCCリトライ枯渇・接続断等）が
/// 起きたら、その時点でこのグループの処理を打ち切り、失敗位置を返す。
/// 他のMessageGroupIdの処理には影響しない（決定3：グループ単位で区別）。
///
/// 戻り値: 全メッセージが成功したら`None`。途中で失敗したら、失敗した
/// メッセージのインデックスを返す（そこから先は`failed_message_ids_from`で
/// 再試行対象になる）。
async fn process_group(pool: &PgPool, message_group_id: &str, messages: &[SqsMessage]) -> Option<usize> {
    for (index, message) in messages.iter().enumerate() {
        if let Err(error) = process_message(pool, message).await {
            tracing::error!(
                message_group_id,
                message_id = ?message.message_id,
                %error,
                "infra failure processing message; stopping this group, other groups continue"
            );
            return Some(index);
        }
    }
    None
}

/// 1メッセージをOCCリトライ付きの1トランザクションとして処理する。
/// `DomainError`はこの関数のOkの範囲内で処理済みとして扱われ（決定1）、
/// ここでErrを返すのはOCCリトライを使い切った等のインフラ起因の失敗のみ。
async fn process_message(pool: &PgPool, message: &SqsMessage) -> Result<(), Error> {
    let message_id = message
        .message_id
        .clone()
        .ok_or("SQS message missing messageId")?;
    let body = message.body.as_deref().unwrap_or_default();
    let envelope: AccountCommandEnvelope = serde_json::from_str(body)?;

    // `transaction_with_retry`はOCC競合のたびにクロージャ全体を再実行するため、
    // 呼び出しごとに複製できるよう所有データをクロージャ側に持たせる。
    let mut pool = pool.clone();
    pool.transaction_with_retry(None, move |tx| {
        let message_id = message_id.clone();
        let envelope = envelope.clone();
        Box::pin(async move { persistence::apply_command(tx, &message_id, &envelope).await })
    })
    .await?;

    Ok(())
}

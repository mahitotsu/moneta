use std::time::Duration;

use aws_lambda_events::sqs::{SqsBatchResponse, SqsEvent, SqsMessage};
use aws_sdk_dynamodb::Client;
use lambda_runtime::{Error, LambdaEvent};
use rand::Rng;

use crate::batch::failed_message_ids_from;
use crate::grouping::group_by_message_group_id;
use crate::persistence::{self, AccountCommandEnvelope, AccountTables, ApplyCommandError};

/// 楽観ロック競合のリトライ上限と基準遅延(docs/adr/0002決定6・0013決定2)。DynamoDBは
/// `ConditionExpression`不成立時に自動リトライしないため、ここで自前に実装する。
const MAX_ATTEMPTS: u32 = 3;
const BASE_DELAY: Duration = Duration::from_millis(20);

pub async fn function_handler(
    event: LambdaEvent<SqsEvent>,
    client: Client,
    tables: AccountTables,
) -> Result<SqsBatchResponse, Error> {
    let groups = group_by_message_group_id(event.payload.records);
    let mut failed_message_ids = Vec::new();

    for (message_group_id, messages) in groups {
        if let Some(failed_from) = process_group(&client, &tables, &message_group_id, &messages).await {
            failed_message_ids.extend(failed_message_ids_from(&messages, failed_from));
        }
    }

    let mut response = SqsBatchResponse::default();
    response.set_failures(failed_message_ids);
    Ok(response)
}

/// 1つのMessageGroupId（= aggregate root ID）に属するメッセージ列を、
/// メッセージ1件につき1回の原子的な書き込み(DynamoDBのTransactWriteItems)として
/// 順番に適用する（docs/adr/0002 決定2、docs/adr/0013決定2）。
///
/// あるメッセージでインフラ起因の失敗（楽観ロックのリトライ枯渇・接続断等）が
/// 起きたら、その時点でこのグループの処理を打ち切り、失敗位置を返す。
/// 他のMessageGroupIdの処理には影響しない（決定3：グループ単位で区別）。
///
/// 戻り値: 全メッセージが成功したら`None`。途中で失敗したら、失敗した
/// メッセージのインデックスを返す（そこから先は`failed_message_ids_from`で
/// 再試行対象になる）。
async fn process_group(
    client: &Client,
    tables: &AccountTables,
    message_group_id: &str,
    messages: &[SqsMessage],
) -> Option<usize> {
    for (index, message) in messages.iter().enumerate() {
        if let Err(error) = process_message(client, tables, message).await {
            tracing::error!(
                message_group_id,
                message_id = ?message.message_id,
                ?error,
                "infra failure processing message; stopping this group, other groups continue"
            );
            return Some(index);
        }
    }
    None
}

/// 1メッセージを楽観ロックのリトライ付きで処理する。`DomainError`はこの関数のOkの範囲内で
/// 処理済みとして扱われ（決定1）、ここでErrを返すのはリトライを使い切った等のインフラ起因の
/// 失敗のみ。
async fn process_message(client: &Client, tables: &AccountTables, message: &SqsMessage) -> Result<(), Error> {
    let message_id = message.message_id.clone().ok_or("SQS message missing messageId")?;
    let body = message.body.as_deref().unwrap_or_default();
    let envelope: AccountCommandEnvelope = serde_json::from_str(body)?;

    let mut attempt = 0;
    loop {
        match persistence::apply_command(client, tables, &message_id, &envelope).await {
            Ok(()) => return Ok(()),
            Err(ApplyCommandError::OptimisticLockConflict) if attempt + 1 < MAX_ATTEMPTS => {
                attempt += 1;
                let jitter = Duration::from_millis(rand::thread_rng().gen_range(0..50));
                tokio::time::sleep(BASE_DELAY * 2u32.pow(attempt) + jitter).await;
            }
            Err(err) => return Err(err.into()),
        }
    }
}

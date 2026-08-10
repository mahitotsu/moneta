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
                // production-readiness-matrix.md O2: このリトライ分岐は追加前は無音だった
                // (2026-08-10発見)。実運用でこの分岐が実際に発火しているかを知る手段が
                // 皆無だったため、まずログだけでも追加する(カスタムメトリクス化は別途)。
                tracing::warn!(
                    message_id = ?message.message_id,
                    attempt,
                    max_attempts = MAX_ATTEMPTS,
                    "optimistic lock conflict on account write; retrying in-Lambda"
                );
                let jitter = Duration::from_millis(rand::thread_rng().gen_range(0..50));
                tokio::time::sleep(BASE_DELAY * 2u32.pow(attempt) + jitter).await;
            }
            Err(err) => return Err(err.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use aws_sdk_dynamodb::operation::get_item::GetItemOutput;
    use aws_sdk_dynamodb::operation::transact_write_items::{TransactWriteItemsError, TransactWriteItemsOutput};
    use aws_sdk_dynamodb::types::error::TransactionCanceledException;
    use aws_sdk_dynamodb::types::{AttributeValue, CancellationReason};
    use aws_smithy_mocks::{mock, mock_client, RuleMode};

    use super::*;

    /// docs/adr/0002の「追記(2026-08-10)」・production-readiness-matrix.md R2:
    /// このリトライ分岐は、黒箱のHTTP並行リクエストではAWSの「1メッセージグループにつき
    /// 同時に1つのLambda実行」保証により再現できない。DynamoDBクライアントをHTTPトランスポート
    /// 層でモック化し、1回目に`TransactionCanceledException`(2番目のTransactItem=accounts
    /// 書き込みが`ConditionalCheckFailed`)、2回目に成功を返させることで、決定論的に
    /// リトライループそのものの正しさを検証する——[[0003-domain-service-crate-boundary]]が
    /// 退けた「リポジトリ抽象化層の追加」ではなく、HTTPトランスポートの差し替えというテスト時
    /// のみのレイヤーであることに注意。
    #[tokio::test]
    async fn optimistic_lock_conflict_is_retried_in_lambda_and_eventually_succeeds() {
        let account_id = account_domain::Uuid::new_v4();

        let get_item_rule = mock!(aws_sdk_dynamodb::Client::get_item).then_output(move || {
            let mut item = HashMap::new();
            item.insert("accountId".to_string(), AttributeValue::S(account_id.to_string()));
            item.insert("ownerId".to_string(), AttributeValue::S("test-owner".to_string()));
            item.insert("status".to_string(), AttributeValue::S("active".to_string()));
            item.insert("balance".to_string(), AttributeValue::S("100".to_string()));
            item.insert("version".to_string(), AttributeValue::N("1".to_string()));
            GetItemOutput::builder().set_item(Some(item)).build()
        });

        // TransactItemsの並びは常に[冪等性チェック, accounts書き込み, イベント挿入]
        // (persistence.rsのapply_command)。reasons[0]="None"(冪等性チェック自体は
        // 不成立ではない)、reasons[1]="ConditionalCheckFailed"(accounts側のversion競合)。
        let conflict_reasons = vec![
            CancellationReason::builder().code("None").build(),
            CancellationReason::builder().code("ConditionalCheckFailed").build(),
            CancellationReason::builder().code("None").build(),
        ];
        let transact_write_rule = mock!(aws_sdk_dynamodb::Client::transact_write_items)
            .sequence()
            .error(move || {
                TransactWriteItemsError::TransactionCanceledException(
                    TransactionCanceledException::builder().set_cancellation_reasons(Some(conflict_reasons.clone())).build(),
                )
            })
            .output(|| TransactWriteItemsOutput::builder().build())
            .build();

        let client = mock_client!(
            aws_sdk_dynamodb,
            RuleMode::MatchAny,
            [&get_item_rule, &transact_write_rule]
        );

        let tables = AccountTables {
            accounts: "accounts".to_string(),
            events: "account_events".to_string(),
            processed_messages: "processed_messages".to_string(),
        };
        let mut message = SqsMessage::default();
        message.message_id = Some("msg-1".to_string());
        message.body = Some(format!(r#"{{"account_id":"{account_id}","command":{{"Deposit":{{"amount":"50"}}}}}}"#));

        let result = process_message(&client, &tables, &message).await;

        assert!(result.is_ok(), "expected the retry to eventually succeed, got {result:?}");
        // 1回目(失敗)+2回目(成功)=2回呼ばれたことを確認する——リトライが実際に発火した
        // ことの直接証拠(このテストが書かれる前は、この分岐が本当に実行されるのか誰にも
        // 分からなかった)。
        assert_eq!(transact_write_rule.num_calls(), 2);
        // apply_commandは各試行のたびに現在の状態を読み直す(version等)ため、get_itemも
        // transact_write_itemsと同じ回数(2回)呼ばれる。
        assert_eq!(get_item_rule.num_calls(), 2);
    }
}

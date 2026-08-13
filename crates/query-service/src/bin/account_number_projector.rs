use account_domain::{Event, EventEnvelope, Rfc3339, Uuid};
use aws_lambda_events::eventbridge::EventBridgeEvent;
use aws_sdk_dynamodb::types::AttributeValue;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use query_service::account_number::{assign_branch, candidate_number};

const EVENT_KIND: &str = "event";

/// 楽観ロック競合ではなく口座番号候補の衝突を数えるリトライだが、形は
/// account-service/src/handler.rsのOCCリトライと同じ(docs/adr/0015決定3)。
const MAX_ATTEMPTS: u32 = 5;

/// query-service専用の、人間可読な口座番号(支店+7桁番号)のためだけの小さなイベント駆動投影
/// (docs/adr/0015)。`crates/transfer-service/src/bin/owner_projector.rs`(docs/adr/0011)と
/// 同型: `account.event.Opened`だけを購読し、`Opened`一度きりで決まる不変データを専用の
/// 小テーブルへ書く。query-serviceの`AccountViewTable`(`query_projector.rs`)には相乗りしない
/// ——あちらは`view_from_event`がイベント単体からフルの新state JSONを都度PutItemする
/// 「洗い替え」設計のため、口座番号のような不変データを他のイベント(Deposited/Withdrawn等)の
/// 書き込み時に消さずに引き継ぐには読み取り-書き込みマージが必要になり複雑化する。
///
/// owner_projector.rsと違う点は、口座番号だけは新規に一意な値を採番する必要があること
/// (`reserve_account_number`の衝突再試行ループ)。支店は一意性を要求しないため決定的に
/// 割り当てる(`assign_branch`)。
#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .without_time()
        .init();

    let table_name =
        std::env::var("ACCOUNT_NUMBERS_TABLE_NAME").expect("ACCOUNT_NUMBERS_TABLE_NAME environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = aws_sdk_dynamodb::Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<EventBridgeEvent<EventEnvelope>>| {
        let dynamodb = dynamodb.clone();
        let table_name = table_name.clone();
        async move { project_one(&dynamodb, &table_name, event.payload.detail).await }
    }))
    .await
}

async fn project_one(dynamodb: &aws_sdk_dynamodb::Client, table_name: &str, envelope: EventEnvelope) -> Result<(), Error> {
    if envelope.kind != EVENT_KIND {
        // EventBridge Rule側の購読条件(account.event.Openedのみ)を満たしていれば通常ここには
        // 来ないが、他のprojectorと同じく境界での防御チェックとして残す。
        tracing::warn!(kind = %envelope.kind, "ignoring non-event envelope");
        return Ok(());
    }

    let event: Event = serde_json::from_value(envelope.data)?;

    let Event::Opened { owner_id, .. } = event else {
        // 購読条件がaccount.event.Openedだけのはずだが、万一広がっても無害に無視する。
        tracing::warn!("ignoring non-Opened event delivered to the account number projector");
        return Ok(());
    };

    let (branch_code, branch_name) = assign_branch(envelope.account_id);
    reserve_account_number(dynamodb, table_name, envelope.account_id, &owner_id, branch_code, branch_name, envelope.occurred_at)
        .await
}

/// 候補生成→`ConditionExpression: attribute_not_exists(accountNumber)`付き`PutItem`での予約→
/// 条件不成立(衝突)なら候補を作り直して再試行、というループ(docs/adr/0015決定3)。
async fn reserve_account_number(
    dynamodb: &aws_sdk_dynamodb::Client,
    table_name: &str,
    account_id: Uuid,
    owner_id: &str,
    branch_code: &str,
    branch_name: &str,
    occurred_at: account_domain::OffsetDateTime,
) -> Result<(), Error> {
    let mut rng = rand::thread_rng();
    let created_at = occurred_at.format(&Rfc3339).expect("OffsetDateTime always formats as RFC3339");

    for attempt in 0..MAX_ATTEMPTS {
        let candidate = candidate_number(&mut rng);

        let result = dynamodb
            .put_item()
            .table_name(table_name)
            .item("accountNumber", AttributeValue::S(candidate.clone()))
            .item("accountId", AttributeValue::S(account_id.to_string()))
            .item("ownerId", AttributeValue::S(owner_id.to_string()))
            .item("branchCode", AttributeValue::S(branch_code.to_string()))
            .item("branchName", AttributeValue::S(branch_name.to_string()))
            .item("createdAt", AttributeValue::S(created_at.clone()))
            .condition_expression("attribute_not_exists(accountNumber)")
            .send()
            .await;

        match result {
            Ok(_) => return Ok(()),
            Err(err) => {
                let is_collision =
                    err.as_service_error().is_some_and(|service_err| service_err.is_conditional_check_failed_exception());
                if !is_collision {
                    return Err(err.into());
                }
                // production-readiness-matrix.md O2と同じ理由でログを残す:
                // この分岐が実際に発火しているかを知る手段がなければ、衝突再試行が機能して
                // いることを運用上確認できない。
                tracing::warn!(
                    %account_id,
                    attempt,
                    max_attempts = MAX_ATTEMPTS,
                    "account number candidate collided; retrying"
                );
            }
        }
    }

    tracing::error!(%account_id, max_attempts = MAX_ATTEMPTS, "exhausted retries generating a unique account number");
    Err("exhausted account number generation retries".into())
}

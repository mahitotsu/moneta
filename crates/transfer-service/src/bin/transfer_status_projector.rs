use aws_lambda_events::dynamodb::{Event as DynamoDbEvent, EventRecord};
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Deserialize, Serialize};

/// DynamoDB Streams event source mappingの部分バッチ失敗応答(docs/adr/0012決定1、
/// `account-outbox-projector`と同じ形)。`itemIdentifier`にはストリームレコードの
/// `sequenceNumber`を指定する。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamBatchResponse {
    batch_item_failures: Vec<BatchItemFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct BatchItemFailure {
    item_identifier: String,
}

/// `TransferSagaTable`のNEW_IMAGE形状(`crates/transfer-service/src/persistence.rs`の
/// `saga_to_item`が書き込む属性名と対応させる)。丸ごと転記せず、この構造体が持つフィールドだけ
/// 明示的に写像する(docs/adr/0012決定1)。
#[derive(Debug, Deserialize)]
struct SagaImage {
    #[serde(rename = "transferId")]
    transfer_id: String,
    #[serde(rename = "fromAccountId")]
    from_account_id: String,
    #[serde(rename = "toAccountId")]
    to_account_id: String,
    /// 送金元の名義(docs/adr/0027決定2: item単位の読み取り認可のためAPI Gateway VTLが
    /// `$context.authorizer.claims.sub`と比較する)。`TransferSagaTable`は`saga_to_item`
    /// (persistence.rs)によりサガ作成時から常にこの属性を持つため必須フィールドとして扱える。
    #[serde(rename = "fromOwnerId")]
    from_owner_id: String,
    #[serde(rename = "toOwnerId")]
    to_owner_id: String,
    amount: String,
    kind: String,
    state: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    /// 振込の現金負担分の手数料(docs/adr/0024決定4)。振替・組戻しでは常に"0"。
    /// `saga_to_item`(persistence.rs)が`create_new_saga`の最初の書き込みから常に含める
    /// ため必須フィールドとして扱える(docs/adr/0025で送金詳細画面に表示するために追加)。
    #[serde(rename = "cashFee")]
    cash_fee: String,
    /// 振込の手数料のうちポイントで充当した分(docs/adr/0025決定4)。`cash_fee`と同じく
    /// `saga_to_item`が常に含めるため必須フィールドとして扱える。
    #[serde(rename = "pointsUsed")]
    points_used: String,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let table_name =
        std::env::var("STATUS_VIEW_TABLE_NAME").expect("STATUS_VIEW_TABLE_NAME environment variable must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<DynamoDbEvent>| {
        let dynamodb = dynamodb.clone();
        let table_name = table_name.clone();
        async move { handle_batch(&dynamodb, &table_name, event.payload).await }
    }))
    .await
}

/// `TransferSagaTable`のDynamoDB Streams(NEW_IMAGE)から届いたレコードを`TransferStatusView`
/// へ投影する(docs/adr/0012決定1)。同一`transferId`内の変更順序はDynamoDB Streamsが保証する
/// ため([[0012]]決定1で確認済み)、条件なしの`PutItem`で足りる——同じレコードが再配信されても
/// 最新の状態を上書きするだけで収束する。失敗したレコードだけを`batchItemFailures`として
/// 報告し、そのレコードだけ再試行させる(`account-outbox-projector`と同じ設計思想)。
async fn handle_batch(dynamodb: &Client, table_name: &str, event: DynamoDbEvent) -> Result<StreamBatchResponse, Error> {
    let mut failures = Vec::new();

    for record in &event.records {
        // サガは削除されない(TTLもDeleteも使わない)ため、REMOVEは想定外。念のため無視する。
        if record.event_name == "REMOVE" {
            continue;
        }

        let sequence_number = record.change.sequence_number.clone().unwrap_or_default();
        if let Err(err) = project_one(dynamodb, table_name, record).await {
            tracing::error!(%err, sequence_number, "failed to project transfer status; reporting for retry");
            failures.push(BatchItemFailure { item_identifier: sequence_number });
        }
    }

    Ok(StreamBatchResponse { batch_item_failures: failures })
}

async fn project_one(dynamodb: &Client, table_name: &str, record: &EventRecord) -> Result<(), Error> {
    let image: SagaImage = serde_dynamo::from_item(record.change.new_image.clone())?;

    dynamodb
        .put_item()
        .table_name(table_name)
        .item("transferId", AttributeValue::S(image.transfer_id))
        .item("fromAccountId", AttributeValue::S(image.from_account_id))
        .item("toAccountId", AttributeValue::S(image.to_account_id))
        .item("fromOwnerId", AttributeValue::S(image.from_owner_id))
        .item("toOwnerId", AttributeValue::S(image.to_owner_id))
        .item("amount", AttributeValue::S(image.amount))
        .item("kind", AttributeValue::S(image.kind))
        .item("state", AttributeValue::S(image.state))
        .item("updatedAt", AttributeValue::S(image.updated_at))
        .item("cashFee", AttributeValue::S(image.cash_fee))
        .item("pointsUsed", AttributeValue::S(image.points_used))
        .send()
        .await?;
    Ok(())
}

use aws_lambda_events::dynamodb::{Event as DynamoDbEvent, EventRecord};
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Deserialize, Serialize};
use transfer_service::persistence;
use uuid::Uuid;

/// DynamoDB Streams event source mappingの部分バッチ失敗応答(docs/adr/0012決定1、
/// `transfer-status-projector`と同じ形)。`itemIdentifier`にはストリームレコードの
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

/// `TransferSagaTable`のNEW_IMAGE形状(`transfer_status_projector.rs`のSagaImageと同じ写像元)。
#[derive(Debug, Deserialize)]
struct SagaImage {
    #[serde(rename = "transferId")]
    transfer_id: String,
    #[serde(rename = "fromAccountId")]
    from_account_id: String,
    #[serde(rename = "toAccountId")]
    to_account_id: String,
    amount: String,
    kind: String,
    state: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    let history_table_name =
        std::env::var("CUSTOMER_TRANSFERS_TABLE_NAME").expect("CUSTOMER_TRANSFERS_TABLE_NAME must be set");
    let owner_table_name = std::env::var("OWNER_TABLE_NAME").expect("OWNER_TABLE_NAME must be set");
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb = Client::new(&aws_config);

    run(service_fn(move |event: LambdaEvent<DynamoDbEvent>| {
        let dynamodb = dynamodb.clone();
        let history_table_name = history_table_name.clone();
        let owner_table_name = owner_table_name.clone();
        async move { handle_batch(&dynamodb, &history_table_name, &owner_table_name, event.payload).await }
    }))
    .await
}

/// `TransferSagaTable`のDynamoDB Streams(NEW_IMAGE)から届いたレコードを、送金元・送金先
/// **両方**のownerId向けに`CustomerTransfersTable`へ投影する(docs/adr/0017決定2)。振込
/// (名義不一致)は両者の「送金」タブに現れ、振替(同一名義)は結果的に1件に収束する。
/// `transfer-status-projector`と同じく、同一transferId内の変更順序はDynamoDB Streamsが
/// 保証するため([[0012]]決定1で確認済み)、条件なしの`PutItem`で足りる。
async fn handle_batch(
    dynamodb: &Client,
    history_table_name: &str,
    owner_table_name: &str,
    event: DynamoDbEvent,
) -> Result<StreamBatchResponse, Error> {
    let mut failures = Vec::new();

    for record in &event.records {
        // サガは削除されない(TTLもDeleteも使わない)ため、REMOVEは想定外。念のため無視する。
        if record.event_name == "REMOVE" {
            continue;
        }

        let sequence_number = record.change.sequence_number.clone().unwrap_or_default();
        if let Err(err) = project_one(dynamodb, history_table_name, owner_table_name, record).await {
            tracing::error!(%err, sequence_number, "failed to project transfer history; reporting for retry");
            failures.push(BatchItemFailure { item_identifier: sequence_number });
        }
    }

    Ok(StreamBatchResponse { batch_item_failures: failures })
}

async fn project_one(
    dynamodb: &Client,
    history_table_name: &str,
    owner_table_name: &str,
    record: &EventRecord,
) -> Result<(), Error> {
    let image: SagaImage = serde_dynamo::from_item(record.change.new_image.clone())?;
    let from_account_id: Uuid = image.from_account_id.parse()?;
    let to_account_id: Uuid = image.to_account_id.parse()?;

    // 名義がまだowner indexに反映されていない場合は`Ok(None)`(エラーではない、
    // [[eventual_consistency_not_a_failure]])——呼び出し元に伝播させてバッチ項目失敗として
    // 報告し、Lambdaの再試行に委ねる(`transfer-command-intake`が同じ状況を扱う方法と同じ)。
    let from_owner = persistence::load_owner(dynamodb, owner_table_name, from_account_id)
        .await?
        .ok_or_else(|| format!("owner not yet indexed for account {from_account_id}"))?;
    let to_owner = persistence::load_owner(dynamodb, owner_table_name, to_account_id)
        .await?
        .ok_or_else(|| format!("owner not yet indexed for account {to_account_id}"))?;

    put_history_row(dynamodb, history_table_name, &from_owner, &image).await?;
    if to_owner != from_owner {
        put_history_row(dynamodb, history_table_name, &to_owner, &image).await?;
    }
    Ok(())
}

async fn put_history_row(
    dynamodb: &Client,
    table_name: &str,
    owner_id: &str,
    image: &SagaImage,
) -> Result<(), aws_sdk_dynamodb::Error> {
    // SK(範囲キー)は`transferId`そのもの——`updatedAt`を含めない。含めていた最初の実装では
    // サガが状態遷移するたび(pending_confirmation→pending_debit→pending_credit→credited等)に
    // SKが変わり、条件なしPutItemが「上書き」ではなく「別アイテムの追加」になってしまい、
    // 完了済みの送金1件が一覧に4〜7行も重複して並ぶ実バグとして発覚した(実デプロイでの
    // 確認により判明、docs/adr/0017)。`transferId`をそのままSKにすることで、同一transferIdの
    // 複数回の状態遷移は常に同じアイテムへ収束する——`transfer-status-projector`が
    // `TransferStatusView`をtransferId単位のPutItemで収束させているのと同じ設計。
    // 「新しい順」の並び替えは別のGSI(`byUpdatedAt`)に委ねる(infra側)。
    dynamodb
        .put_item()
        .table_name(table_name)
        .item("ownerId", AttributeValue::S(owner_id.to_string()))
        .item("transferId", AttributeValue::S(image.transfer_id.clone()))
        .item("fromAccountId", AttributeValue::S(image.from_account_id.clone()))
        .item("toAccountId", AttributeValue::S(image.to_account_id.clone()))
        .item("amount", AttributeValue::S(image.amount.clone()))
        .item("kind", AttributeValue::S(image.kind.clone()))
        .item("state", AttributeValue::S(image.state.clone()))
        .item("updatedAt", AttributeValue::S(image.updated_at.clone()))
        .send()
        .await?;
    Ok(())
}

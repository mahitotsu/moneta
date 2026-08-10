import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { REGION } from "./stackOutputs";
import { waitFor, WaitForOptions } from "./poll";

let cachedDoc: DynamoDBDocumentClient | undefined;
function doc(): DynamoDBDocumentClient {
  if (!cachedDoc) cachedDoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cachedDoc;
}

// 口座名義インデックス(`crates/transfer-service/src/bin/owner_projector.rs`、docs/adr/0011)への
// 反映待ち。`account.event.Opened`のoutbox発行を経て投影されるため、これも`waitFor`で
// ポーリングする。照会APIを持たない内部専用インデックスであり(docs/adr/0012はサガ状態の
// 照会APIだけを新設した——名義インデックスはfurikae/furikomi判定というTransfer service内部の
// 関心事に留まる)、この直接アクセスは裏口ではなく妥当な検証手段である。
export async function waitForOwnerIndexed(
  ownerTableName: string,
  accountId: string,
  options: WaitForOptions = {},
): Promise<string> {
  return waitFor(
    async () => {
      const result = await doc().send(new GetCommand({ TableName: ownerTableName, Key: { accountId } }));
      const ownerId = result.Item?.ownerId as string | undefined;
      return ownerId ?? undefined;
    },
    { description: `account ${accountId} to appear in the owner index`, ...options },
  );
}

// テスト専用: 組戻し(recall)の時間窓(`RECALL_WINDOW`、saga.rs)の期限切れを、実時間24時間
// 待つ代わりに`updatedAt`を直接過去へ書き換えて模擬する(docs/e2e-scenarios.md FC12, 旧J10)。
// アプリケーションの通常の書き込み経路(advance_saga_state)を経由しない、この検証だけの
// 裏口であることを明示するため、他のヘルパーとは呼び出し方を変えている
// (support/dlq.tsがDLQを直接操作するのと同じ位置づけ)。公開APIには対応する経路が
// そもそも存在しない(実時間を早送りする手段はAPIでは提供できない)ため、docs/adr/0012の
// 照会API新設後もこの直接書き込みは残す。
export async function backdateSagaUpdatedAt(sagaTableName: string, transferId: string, hoursAgo: number): Promise<void> {
  const backdated = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  await doc().send(
    new UpdateCommand({
      TableName: sagaTableName,
      Key: { transferId },
      UpdateExpression: "SET updatedAt = :t",
      ExpressionAttributeValues: { ":t": backdated },
    }),
  );
}

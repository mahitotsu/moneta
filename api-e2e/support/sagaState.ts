import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { REGION } from "./stackOutputs";
import { waitFor, WaitForOptions } from "./poll";

let cachedDoc: DynamoDBDocumentClient | undefined;
function doc(): DynamoDBDocumentClient {
  if (!cachedDoc) cachedDoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cachedDoc;
}

let cachedLambda: LambdaClient | undefined;
function lambda(): LambdaClient {
  if (!cachedLambda) cachedLambda = new LambdaClient({ region: REGION });
  return cachedLambda;
}

// テスト専用: transfer-saga-watchdog(docs/adr/0028)の5分ごとのスケジュールを待たず、
// 直接同期invokeして即座に1回分のスイープを走らせる。backdateSagaUpdatedAtと同じ
// 「テスト専用の裏口」の位置づけ——実時間で5分待つ手段を公開APIは提供しないため、
// この直接invokeが唯一の現実的な検証手段になる。
export async function invokeSagaWatchdog(functionName: string): Promise<void> {
  const result = await lambda().send(new InvokeCommand({ FunctionName: functionName, Payload: new TextEncoder().encode("{}") }));
  if (result.FunctionError) {
    const payload = result.Payload ? new TextDecoder().decode(result.Payload) : "";
    throw new Error(`invokeSagaWatchdog: Lambda returned FunctionError=${result.FunctionError}: ${payload}`);
  }
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

// docs/adr/0028: ウォッチドッグが実際に再送を試みたことを、状態の不変(消極的な証拠)だけで
// なく直接確認するための読み取り専用ヘルパー。`watchdogRetryCount`は照会APIを持たない
// ウォッチドッグ専用のブックキーピング属性(`crates/transfer-service/src/persistence.rs`の
// `record_watchdog_retry`のコメント参照)。
export async function getWatchdogRetryCount(sagaTableName: string, transferId: string): Promise<number> {
  const result = await doc().send(new GetCommand({ TableName: sagaTableName, Key: { transferId } }));
  return (result.Item?.watchdogRetryCount as number | undefined) ?? 0;
}

export interface StuckCompensatingSaga {
  transferId: string;
  fromAccountId: string;
  ownerId: string;
  amount: string;
}

// テスト専用: docs/adr/0028(サガの自己修復ウォッチドッグ)を検証するための裏口。
//
// `Compensating`で「恒久的に詰まった」サガ(補償の入金先の口座が凍結中で、`advance`が
// 却下をNextAction::Noneとして扱う設計、docs/adr/0010決定6・R7)を実機で再現しようとすると、
// 「送金元の口座は最初の出金時は凍結されておらず、補償の再入金が試みられる直前にだけ凍結
// されている」必要があり、これは実際の分散システム(SQS→Lambda→EventBridgeの複数ホップ)の
// タイミングに依存する競合状態になってしまい、決定論的なテストにならない。
//
// backdateSagaUpdatedAtが「24時間実時間を待つ手段を公開APIが提供しない」ことを理由に直接
// 書き込みを裏口として使っているのと同じ理由(support/sagaState.tsの当該コメント参照)で、
// ここでも「詰まった状態を意図的に作る」こと自体を直接書き込みで行う——ただし**回復の検証
// そのもの(ウォッチドッグの再送・account-serviceでの実処理・サガの状態遷移)は、この後
// 呼び出し側がinvokeSagaWatchdog経由で実機に対して行う、正真正銘のE2E検証のまま**。
// DynamoDB Streamsはどの書き込み経路であっても等しく発火するため、この直接PutItemの後も
// transfer-status-projectorが正しくTransferStatusViewへ投影し、GET /transfers/{id}で
// 通常通り観測できる。
export async function seedStuckCompensatingSaga(
  sagaTableName: string,
  saga: StuckCompensatingSaga,
  updatedHoursAgo: number,
): Promise<void> {
  const updatedAt = new Date(Date.now() - updatedHoursAgo * 60 * 60 * 1000).toISOString();
  await doc().send(
    new PutCommand({
      TableName: sagaTableName,
      Item: {
        transferId: saga.transferId,
        fromAccountId: saga.fromAccountId,
        toAccountId: crypto.randomUUID(), // Compensating状態では参照されない(補償はfromAccountId宛のみ)。
        fromOwnerId: saga.ownerId,
        toOwnerId: saga.ownerId, // furikae(同一名義)として構成する——手数料/ポイントを一切絡めない。
        amount: saga.amount,
        cashFee: "0",
        pointsUsed: "0",
        kind: "furikae",
        state: "compensating",
        updatedAt,
      },
    }),
  );
}

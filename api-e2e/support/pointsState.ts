// ポイント台帳(`PointsTable`)・手数料予約台帳(`FeeReservationsTable`、docs/adr/0024)への
// 直接アクセス。support/sagaState.tsのwaitForOwnerIndexedと同じ理由(照会APIを持たない
// バックエンド専用のテーブルであり、この直接アクセスは裏口ではなく妥当な検証手段)。
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { REGION } from "./stackOutputs";
import { waitFor, WaitForOptions } from "./poll";

let cachedDoc: DynamoDBDocumentClient | undefined;
function doc(): DynamoDBDocumentClient {
  if (!cachedDoc) cachedDoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cachedDoc;
}

export async function getPointsBalance(pointsTableName: string, ownerId: string): Promise<number | undefined> {
  const result = await doc().send(new GetCommand({ TableName: pointsTableName, Key: { ownerId } }));
  const balance = result.Item?.balance as string | undefined;
  return balance === undefined ? undefined : Number(balance);
}

export async function waitForPointsBalance(
  pointsTableName: string,
  ownerId: string,
  expected: number,
  options: WaitForOptions = {},
): Promise<number> {
  return waitFor(
    async () => {
      const balance = await getPointsBalance(pointsTableName, ownerId);
      return balance === expected ? balance : undefined;
    },
    { description: `points balance for owner ${ownerId} to reach ${expected}`, ...options },
  );
}

// テスト専用の裏口(support/sagaState.tsのbackdateSagaUpdatedAtと同じ位置づけ): ポイントを
// 実際に貯める唯一の公開経路は振込の受取(AwardPoints、決定7)であり、「充当できるだけの
// ポイントを保有した状態」をAPI経由で素早く作る手段がない。`version`属性を1にして書く
// ——`persistence.rs`の`points_write`が「既存項目」として扱う形(`version`欠落のまま書くと、
// 後続の書き込みが`attribute_not_exists(ownerId)`条件で衝突し楽観ロック競合を繰り返す)。
export async function seedPointsBalance(pointsTableName: string, ownerId: string, balance: number): Promise<void> {
  await doc().send(
    new PutCommand({
      TableName: pointsTableName,
      Item: { ownerId, balance: String(balance), version: 1 },
    }),
  );
}

export async function getFeeReservation(
  feeReservationsTableName: string,
  transferId: string,
): Promise<{ state: string; pointsUsed: number; feeAmount: number } | undefined> {
  const result = await doc().send(new GetCommand({ TableName: feeReservationsTableName, Key: { transferId } }));
  if (!result.Item) return undefined;
  return {
    state: result.Item.state as string,
    pointsUsed: Number(result.Item.pointsUsed),
    feeAmount: Number(result.Item.feeAmount),
  };
}

export async function waitForFeeReservationState(
  feeReservationsTableName: string,
  transferId: string,
  states: string[],
  options: WaitForOptions = {},
): Promise<{ state: string; pointsUsed: number; feeAmount: number }> {
  return waitFor(
    async () => {
      const reservation = await getFeeReservation(feeReservationsTableName, transferId);
      return reservation && states.includes(reservation.state) ? reservation : undefined;
    },
    { description: `fee reservation ${transferId} to reach state in [${states.join(", ")}]`, ...options },
  );
}

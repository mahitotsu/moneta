// Deployed-stack introspection shared by operational scripts (scripts/clean-data.ts) and the
// E2E test harness (api-e2e/): both need to resolve live endpoint URLs/resource names via
// CloudFormation outputs rather than hardcoding them.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";

export const STACK_NAME = "MonetaAccountPipelineStack";
// This PoC's AWS session is scoped to ap-northeast-1 (Tokyo) -- see infra/bin/infra.ts.
export const REGION = "ap-northeast-1";

export interface StackOutputs {
  // account-service自身の永続化(docs/adr/0013)。
  accountsTableName: string;
  accountEventsTableName: string;
  processedMessagesTableName: string;
  commandQueueUrl: string;
  deadLetterQueueUrl: string;
  accountViewTableName: string;
  accountHistoryTableName: string;
  commandApiUrl: string;
  queryApiUrl: string;
  outboxProjectorFunctionName: string;
  // Transfer service(docs/adr/0010・0011)。
  transferCommandQueueUrl: string;
  transferSagaTableName: string;
  transferAccountOwnersTableName: string;
  // Transfer serviceの顧客向け入口(docs/adr/0012)。seed-demo-data.tsが実際に振替/振込を
  // 実行するのに使う。
  transferCommandApiUrl: string;
  transferQueryApiUrl: string;
  transferStatusViewTableName: string;
  // 人間可読な口座番号(docs/adr/0015)。振込先の支店+口座番号を解決するのに使う。
  accountNumberQueryApiUrl: string;
  accountNumbersTableName: string;
  // 本物の顧客-口座関係(docs/adr/0016決定4)。
  customerAccountsTableName: string;
  // Amazon Cognitoによる実認証(docs/adr/0016)。clean-data.tsのCognitoテストユーザー掃除
  // (AdminDeleteUser/ListUsersはUserPoolClientIdではなくUserPoolIdで引く)、
  // seed-demo-data.tsのデモユーザー作成の両方に使う。
  userPoolId: string;
  userPoolClientId: string;
  // ポイント残高照会(docs/adr/0025)。seed-demo-data.tsが投入結果のサマリにポイント残高を
  // 表示するのに使う——この型がADR-0024〜0026のCfnOutputを一つも知らなかったため、
  // デモデータ投入時に手数料/ポイントの状態を確認する手段が無かった(2026-08-19発見)。
  pointsQueryApiUrl: string;
  // 銀行所有の仮受金口座(docs/adr/0028)。setup-suspense-account.tsがこのIDで口座を開設する。
  suspenseAccountId: string;
}

const OUTPUT_KEYS: Record<keyof StackOutputs, string> = {
  accountsTableName: "AccountsTableName",
  accountEventsTableName: "AccountEventsTableName",
  processedMessagesTableName: "ProcessedMessagesTableName",
  commandQueueUrl: "CommandQueueUrl",
  deadLetterQueueUrl: "DeadLetterQueueUrl",
  accountViewTableName: "AccountViewTableName",
  accountHistoryTableName: "AccountHistoryTableName",
  commandApiUrl: "CommandApiUrl",
  queryApiUrl: "QueryApiUrl",
  outboxProjectorFunctionName: "OutboxProjectorFunctionName",
  transferCommandQueueUrl: "TransferCommandQueueUrl",
  transferSagaTableName: "TransferSagaTableName",
  transferAccountOwnersTableName: "TransferAccountOwnersTableName",
  transferCommandApiUrl: "TransferCommandApiUrl",
  transferQueryApiUrl: "TransferQueryApiUrl",
  transferStatusViewTableName: "TransferStatusViewTableName",
  accountNumberQueryApiUrl: "AccountNumberQueryApiUrl",
  accountNumbersTableName: "AccountNumbersTableName",
  customerAccountsTableName: "CustomerAccountsTableName",
  userPoolId: "UserPoolId",
  userPoolClientId: "UserPoolClientId",
  pointsQueryApiUrl: "PointsQueryApiUrl",
  suspenseAccountId: "SuspenseAccountId",
};

export async function fetchStackOutputs(): Promise<StackOutputs> {
  const cfn = new CloudFormationClient({ region: REGION });
  const response = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const outputs = response.Stacks?.[0]?.Outputs ?? [];
  const byKey = new Map(outputs.map((o) => [o.OutputKey, o.OutputValue]));

  const result = {} as StackOutputs;
  for (const [field, outputKey] of Object.entries(OUTPUT_KEYS) as [keyof StackOutputs, string][]) {
    const value = byKey.get(outputKey);
    if (!value) {
      throw new Error(`Stack "${STACK_NAME}" is missing output "${outputKey}"`);
    }
    result[field] = value;
  }
  return result;
}

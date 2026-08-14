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
  // Transfer serviceの顧客向け入口(docs/adr/0012)。
  transferCommandApiUrl: string;
  transferQueryApiUrl: string;
  // 人間可読な口座番号(docs/adr/0015)。
  accountNumberQueryApiUrl: string;
  accountNumbersTableName: string;
  // Amazon Cognitoによる実認証(docs/adr/0016)。support/auth.tsのsignUpAndSignInに渡す。
  userPoolClientId: string;
  // 本物の顧客-口座関係(docs/adr/0016決定4)。support/testDataCleanup.tsが
  // テストで作った口座の後片付けに使う。
  customerAccountsTableName: string;
  transferStatusViewTableName: string;
  // 顧客ごとの送金履歴(docs/adr/0017)。support/testDataCleanup.tsのcleanupTestDataが
  // テストで作った送金の後片付けに使う。
  customerTransfersTableName: string;
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
  accountNumberQueryApiUrl: "AccountNumberQueryApiUrl",
  accountNumbersTableName: "AccountNumbersTableName",
  userPoolClientId: "UserPoolClientId",
  customerAccountsTableName: "CustomerAccountsTableName",
  transferStatusViewTableName: "TransferStatusViewTableName",
  customerTransfersTableName: "CustomerTransfersTableName",
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

// Deployed-stack introspection shared by operational scripts (scripts/clean-data.ts) and the
// E2E test harness (e2e/): both need to resolve live endpoint URLs/resource names via
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

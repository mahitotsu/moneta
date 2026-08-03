// Deployed-stack introspection shared by operational scripts (scripts/clean-data.ts) and the
// E2E test harness (e2e/): both need to resolve live endpoint URLs/resource names via
// CloudFormation outputs rather than hardcoding them.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";

export const STACK_NAME = "MonetaAccountPipelineStack";
// Aurora DSQL availability and this PoC's AWS session are both scoped to ap-northeast-1
// (Tokyo) -- see infra/bin/infra.ts.
export const REGION = "ap-northeast-1";

export interface StackOutputs {
  clusterEndpoint: string;
  commandQueueUrl: string;
  deadLetterQueueUrl: string;
  accountViewTableName: string;
  accountHistoryTableName: string;
  commandApiUrl: string;
  queryApiUrl: string;
}

const OUTPUT_KEYS: Record<keyof StackOutputs, string> = {
  clusterEndpoint: "ClusterEndpoint",
  commandQueueUrl: "CommandQueueUrl",
  deadLetterQueueUrl: "DeadLetterQueueUrl",
  accountViewTableName: "AccountViewTableName",
  accountHistoryTableName: "AccountHistoryTableName",
  commandApiUrl: "CommandApiUrl",
  queryApiUrl: "QueryApiUrl",
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

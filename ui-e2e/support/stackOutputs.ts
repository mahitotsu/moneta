// Deployed-stack introspection, duplicated from api-e2e/support/stackOutputs.ts rather than
// imported (docs/adr/0014): api-e2e/ and ui-e2e/ are independent top-level packages by design,
// same reasoning infra/README.md already gives for why api-e2e/ doesn't import infra/'s copy of
// this same file. Trimmed to only the outputs ui-e2e/ actually needs (the harness drives the
// deployed web-ui through a real browser and seeds accounts directly over HTTP -- it has no use
// for the write-side queue/table names api-e2e/'s copy also carries).
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";

export const STACK_NAME = "MonetaAccountPipelineStack";
// This PoC's AWS session is scoped to ap-northeast-1 (Tokyo) -- see infra/bin/infra.ts.
export const REGION = "ap-northeast-1";

export interface StackOutputs {
  webUiUrl: string;
  commandApiUrl: string;
  queryApiUrl: string;
  transferCommandApiUrl: string;
  transferQueryApiUrl: string;
  transferAccountOwnersTableName: string;
}

const OUTPUT_KEYS: Record<keyof StackOutputs, string> = {
  webUiUrl: "WebUiUrl",
  commandApiUrl: "CommandApiUrl",
  queryApiUrl: "QueryApiUrl",
  transferCommandApiUrl: "TransferCommandApiUrl",
  transferQueryApiUrl: "TransferQueryApiUrl",
  transferAccountOwnersTableName: "TransferAccountOwnersTableName",
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

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { fetchStackOutputs, REGION } from "../../support/stackOutputs";

// The outbox relay's own trigger (EventBridge Scheduler, docs/adr/0004) is capped at a hard
// 1-minute floor -- confirmed via AWS's rate-expression docs, rate() can't go below 1 minute --
// which would otherwise dominate the runtime of nearly every scenario in this suite, even
// though almost none of them are actually testing that cadence. `relay_once`
// (crates/account-service/src/bin/outbox_relay.rs) doesn't care how it's invoked (it ignores
// its event payload), so poll.ts's `waitFor` invokes it directly on every poll attempt by
// default to collapse that wait to roughly the relay's own run time. Production's schedule is
// untouched -- this is a test-only acceleration, not an architecture change.
let cachedInvoke: Promise<() => Promise<void>> | undefined;

function getInvoke(): Promise<() => Promise<void>> {
  if (!cachedInvoke) {
    cachedInvoke = fetchStackOutputs().then((outputs) => {
      const client = new LambdaClient({ region: REGION });
      return async () => {
        await client.send(
          new InvokeCommand({ FunctionName: outputs.outboxRelayFunctionName, InvocationType: "RequestResponse" }),
        );
      };
    });
  }
  return cachedInvoke;
}

export async function triggerOutboxRelay(): Promise<void> {
  const invoke = await getInvoke();
  await invoke();
}

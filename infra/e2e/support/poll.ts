export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  description?: string;
}

// Query-side propagation lag is bounded by the outbox relay's EventBridge Scheduler interval
// (1 minute, the Scheduler's own floor -- docs/adr/0004). The relay Lambda itself has a 30s
// timeout per invocation (infra/lib/account-pipeline-stack.ts's AccountOutboxRelayFunction),
// so a large concurrent burst of writes (e.g. running many E2E scenario files in parallel) can
// make some rows miss a tick and roll into the next one; 150s gives margin for that on top of
// the ~1-minute bound without being so long that a genuine regression takes forever to fail.
// This is why infra/package.json's test:e2e caps Jest's --maxWorkers -- to keep the harness's
// own concurrency from being the thing that creates that burst.
const DEFAULT_TIMEOUT_MS = 150_000;
const DEFAULT_INTERVAL_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `check` until it returns a defined value, or throws once `timeoutMs` elapses. Used to
// express "eventually consistent" assertions (docs/e2e-scenarios.md category F) as a bounded
// wait rather than a fixed sleep, so tests fail fast when the system is actually broken and
// don't flake when it's just slow.
export async function waitFor<T>(check: () => Promise<T | undefined>, options: WaitForOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS, description = "condition" } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${description}`);
    }
    await sleep(intervalMs);
  }
}

// For asserting a *rejection* (docs/e2e-scenarios.md category B): there is no positive signal
// to poll for (DomainError rejections aren't published as events -- ADR-0002's "future
// Notification service" gap), so the only externally observable proof is "state stayed put
// for long enough that the command must already have been processed". Rejections are decided
// within a single synchronous SQS-consumed Lambda invocation (no outbox/EventBridge hop), so
// the settle window only needs to cover SQS-to-Lambda delivery latency, not the 1-minute
// projection lag F1/F2 deal with.
export const REJECTION_SETTLE_MS = 15_000;

export async function settle(ms: number = REJECTION_SETTLE_MS): Promise<void> {
  await sleep(ms);
}

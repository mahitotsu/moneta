import { triggerOutboxRelay } from "./relay";

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  description?: string;
  // Defaults to true: invoke the outbox relay directly on every poll attempt instead of
  // waiting on its own 1-minute schedule (see relay.ts for why). Almost no scenario is actually
  // testing that cadence, so almost every caller wants this. The two that ARE testing it (F1/F2,
  // docs/e2e-scenarios.md) pass `triggerRelay: false` for their specific measured wait --
  // triggering the relay there would erase the very thing being measured. `timeoutMs` follows
  // suit unless overridden: short when accelerated, long (the natural ~1-minute bound) when not.
  triggerRelay?: boolean;
}

const ACCELERATED_TIMEOUT_MS = 45_000;
// The natural bound: outbox relay's EventBridge Scheduler interval (1 minute, the Scheduler's
// own floor -- docs/adr/0004) plus margin for a burst of concurrent test-suite writes to miss a
// tick (see infra/e2e/README.md's --maxWorkers note).
const NATURAL_TIMEOUT_MS = 150_000;
const DEFAULT_INTERVAL_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `check` until it returns a defined value, or throws once `timeoutMs` elapses. Used to
// express "eventually consistent" assertions (docs/e2e-scenarios.md category F) as a bounded
// wait rather than a fixed sleep, so tests fail fast when the system is actually broken and
// don't flake when it's just slow.
export async function waitFor<T>(check: () => Promise<T | undefined>, options: WaitForOptions = {}): Promise<T> {
  const { intervalMs = DEFAULT_INTERVAL_MS, description = "condition", triggerRelay = true } = options;
  const timeoutMs = options.timeoutMs ?? (triggerRelay ? ACCELERATED_TIMEOUT_MS : NATURAL_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (triggerRelay) {
      await triggerOutboxRelay();
    }
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
// within a single synchronous SQS-consumed Lambda invocation (no outbox/EventBridge hop, so
// triggering the relay wouldn't affect this path at all) -- the settle window only needs to
// cover SQS-to-Lambda delivery latency, not the projection lag `waitFor` deals with.
export const REJECTION_SETTLE_MS = 15_000;

export async function settle(ms: number = REJECTION_SETTLE_MS): Promise<void> {
  await sleep(ms);
}

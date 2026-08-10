export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  description?: string;
}

// DynamoDB Streamsがaccount_eventsテーブルの変更をaccount-outbox-projectorへ近リアルタイムで
// 配信するため(docs/adr/0004・0013)、ただポーリングするだけで十分に短い時間で収束する。かつては
// EventBridge Schedulerの1分間隔ポーリング(旧account-outbox-relay)を明示的にInvokeして待ち時間を
// 短縮する加速用のフック(support/relay.ts)がここにあったが、そのポーリング機構自体が無くなった
// ため不要になった。
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `check` until it returns a defined value, or throws once `timeoutMs` elapses. Used to
// express "eventually consistent" assertions (docs/e2e-scenarios.md P1) as a bounded
// wait rather than a fixed sleep, so tests fail fast when the system is actually broken and
// don't flake when it's just slow.
export async function waitFor<T>(check: () => Promise<T | undefined>, options: WaitForOptions = {}): Promise<T> {
  const { intervalMs = DEFAULT_INTERVAL_MS, description = "condition", timeoutMs = DEFAULT_TIMEOUT_MS } = options;
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

// For asserting a *rejection* (docs/e2e-scenarios.md FC-category domain errors): there is no positive signal
// to poll for (DomainError rejections aren't published as events -- ADR-0002's "future
// Notification service" gap), so the only externally observable proof is "state stayed put
// for long enough that the command must already have been processed". Rejections are decided
// within a single synchronous SQS-consumed Lambda invocation (no outbox/EventBridge hop) --
// the settle window only needs to cover SQS-to-Lambda delivery latency, not the projection lag
// `waitFor` deals with.
export const REJECTION_SETTLE_MS = 15_000;

export async function settle(ms: number = REJECTION_SETTLE_MS): Promise<void> {
  await sleep(ms);
}

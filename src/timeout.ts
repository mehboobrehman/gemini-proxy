// How long to wait for a connection/initial HTTP response before giving up.
// Meant to bound ONLY the wait for headers — never the subsequent streamed
// body, so a legitimately slow-to-start generation (e.g. a big thinking
// budget) is never cut off by this. Without this, a stalled connection would
// hang indefinitely: orchestrate.ts's wall-clock deadline only gates whether
// a *new* attempt starts, it can't abort one already in flight.
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * `withConnectTimeout` used to build this via `AbortSignal.any([signal,
 * AbortSignal.timeout(CONNECT_TIMEOUT_MS)])` and hand the combined signal
 * straight to `fetch()`. That doesn't do what the comment above claims:
 * `AbortSignal.timeout()` is a bare wall-clock timer with no way to cancel
 * it, and a signal passed to `fetch()` governs the *entire* request per the
 * Fetch spec — headers AND the streamed body. So any generation (thinking +
 * a long response) that took more than 20s in total, even while healthy and
 * actively producing content, got forcibly aborted and surfaced as
 * "The operation timed out." — reproduced live: a real `auto` request with
 * an antigravity account already committed (69 chars of real content
 * already received) was killed 20s after ITS OWN fetch started, mid-stream.
 *
 * Fixed by building the timeout from a plain `AbortController` instead, so
 * the timer can be cancelled the instant `fetch()` resolves (headers
 * received) — see `clearConnectTimeout()`. From then on the returned signal
 * only fires on genuine caller-initiated cancellation, never a stale timer.
 * A real stall *after* headers arrive (no bytes at all for a long time) is a
 * separate concern, handled per-chunk in `sse.ts`'s stall guard instead —
 * that one legitimately does need to keep working through a long response.
 */
export function withConnectTimeout(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  clearConnectTimeout: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    CONNECT_TIMEOUT_MS,
  );
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return { signal: controller.signal, clearConnectTimeout: () => clearTimeout(timer) };
}

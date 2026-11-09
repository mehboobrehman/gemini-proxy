import { pickAccount, rotateAway, minWaitMs, markCooldown, markDisabled, touch, isOAuth, getEligibleAccounts } from "./accounts";
import { generateAntigravity } from "./transports/antigravity";
import { generateApiKey } from "./transports/apikey";
import { TransportError, NoAccountAvailableError, disabledReasonFor } from "./errors";
import { logRequest } from "./requestlog";
import type { Account, Backend, GeminiRequestBody, GeminiResponse } from "./types";

function accountEmail(account: Account): string | undefined {
  return account.backend === "antigravity" ? account.email : account.label;
}

export interface GenerateOptions {
  model: string;
  backend?: Backend;
  body: GeminiRequestBody;
  signal?: AbortSignal;
  /**
   * Only set by orchestrateAutoGenerate, which shares one deadline across
   * every candidate in its chain — without this, each call here would
   * independently start its own fresh WALL_CLOCK_BUDGET_MS window, letting
   * one slow candidate silently starve every candidate after it. Defaults
   * to a fresh window when omitted, preserving exact existing behavior for
   * a pinned-model request.
   */
  deadline?: number;
  /**
   * Only set by orchestrateAutoGenerate. A pinned-model request never
   * cools down on bad_request, since it's almost always our own
   * translation bug — the same client request would fail identically no
   * matter when it's retried, so a cooldown wouldn't help. `auto` picked
   * this exact model itself though, so a 400 there is just as likely to be
   * that one model variant's own quirk (seen live: a plain, valid request
   * 400ing on one tier variant while every other model accepted it fine) —
   * worth remembering for a while so future `auto` requests don't re-probe
   * a known-bad candidate on every single call.
   */
  cooldownOnBadRequest?: boolean;
}

export interface GenerateHandle {
  events: AsyncGenerator<GeminiResponse>;
  accountUsed: Account;
}

async function runTransport(account: Account, model: string, body: GeminiRequestBody, signal: AbortSignal | undefined) {
  return isOAuth(account)
    ? generateAntigravity(account, model, body, { signal })
    : generateApiKey(account, model, body, { signal });
}

async function handleTransportError(account: Account, model: string, err: TransportError): Promise<void> {
  switch (err.kind) {
    case "rate_limit":
      await markCooldown(account.id, model, err.retryAfterMs ?? 30_000, "rate limited (429)");
      break;
    case "quota_exhausted":
      await markCooldown(account.id, model, err.retryAfterMs ?? 6 * 3_600_000, "quota exhausted");
      break;
    case "auth":
    case "invalid_key":
    case "permission":
      await markDisabled(account.id, disabledReasonFor(err)!);
      break;
    case "server":
      await markCooldown(account.id, model, 30_000, "upstream 5xx");
      break;
    case "not_found":
      await markCooldown(account.id, model, 24 * 3_600_000, "model not available on this backend (404)");
      break;
    case "bad_request":
    case "unknown":
      break;
  }
}

const WALL_CLOCK_BUDGET_MS = 60_000;
const AUTO_WALL_CLOCK_BUDGET_MS = 120_000; // shared across the WHOLE chain, not per-candidate — auto has more ground to cover than a single pinned model
const AUTO_BAD_REQUEST_COOLDOWN_MS = 6 * 3_600_000; // same order as quota_exhausted's default — "not usable right now", not "gone forever"

/**
 * "Commit-on-first-content": peeks the first upstream event before returning,
 * so HTTP-status-time failures (429/401/5xx — the overwhelming majority of
 * real failures) are rotated transparently. Once any event has been
 * returned to the caller, this function never retries or switches accounts —
 * replaying would duplicate already-emitted text/tool calls to the client.
 */
export async function orchestrateGenerate(opts: GenerateOptions): Promise<GenerateHandle> {
  const deadline = opts.deadline ?? Date.now() + WALL_CLOCK_BUDGET_MS;
  // Every account added here failed outright (see the catch block below) —
  // growing this set on each iteration is what bounds the loop, since
  // getEligibleAccounts(...) minus triedAccountIds shrinks every time and
  // rotateAway returns null once it's empty. No separate attempt cap needed.
  const triedAccountIds = new Set<string>();
  let lastError: unknown;

  while (Date.now() < deadline) {
    const account = triedAccountIds.size === 0
      ? pickAccount(opts.model, opts.backend)
      : rotateAway(opts.model, opts.backend, triedAccountIds);

    if (!account) {
      const waitMs = minWaitMs(opts.model, opts.backend);
      logRequest({ model: opts.model, backend: opts.backend, outcome: "no_account_available", detail: `retry in ${Math.ceil(waitMs / 1000)}s` });
      throw new NoAccountAvailableError(waitMs);
    }

    try {
      const gen = await runTransport(account, opts.model, opts.body, opts.signal);
      const iterator = gen[Symbol.asyncIterator]();
      const first = await iterator.next();
      await touch(account.id);
      logRequest({ model: opts.model, backend: account.backend, accountId: account.id, accountEmail: accountEmail(account), outcome: "ok" });

      async function* resumed(): AsyncGenerator<GeminiResponse> {
        if (!first.done) yield first.value;
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      }

      return { events: resumed(), accountUsed: account };
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) throw err;

      if (err instanceof TransportError) {
        logRequest({
          model: opts.model,
          backend: account.backend,
          accountId: account.id,
          accountEmail: accountEmail(account),
          outcome: err.kind,
          detail: `HTTP ${err.status}`,
        });
        await handleTransportError(account, opts.model, err);
        if (err.kind === "bad_request") {
          if (opts.cooldownOnBadRequest) {
            await markCooldown(account.id, opts.model, AUTO_BAD_REQUEST_COOLDOWN_MS, "model rejected a request auto considered valid (400)");
          }
          throw err; // never rotate to another account for the same model within one request — a translation bug (or a model-specific quirk) fails identically everywhere
        }
      } else {
        logRequest({
          model: opts.model,
          backend: account.backend,
          accountId: account.id,
          accountEmail: accountEmail(account),
          outcome: "unknown_error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      // Any other error (network hiccup, unclassified) is treated as
      // transient and rotated too, within the wall-clock budget. Excluding
      // it here even though it wasn't cooled down is what prevents an
      // endless bounce between a couple of flapping accounts.
      triedAccountIds.add(account.id);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("All eligible accounts failed.");
}

export interface AutoGenerateOptions {
  /** Ordered candidate model ids, most-preferred first (see auto.ts). */
  chain: string[];
  backend?: Backend;
  /** Re-invoked per candidate — translation can depend on which model was picked (e.g. Claude-shaped messages). */
  buildBody: (model: string) => GeminiRequestBody | Promise<GeminiRequestBody>;
  signal?: AbortSignal;
}

export interface AutoGenerateHandle extends GenerateHandle {
  modelUsed: string;
}

/**
 * Walks the `auto` fallback chain, reusing orchestrateGenerate's existing
 * per-model account rotation unchanged for each candidate. Only advances to
 * the next candidate once every account (across both backends) is
 * exhausted for the current one — see README "How auto model selection
 * works". A candidate with zero eligible accounts is skipped without even
 * attempting a call, so a stale/never-available id in the chain costs
 * nothing.
 */
export async function orchestrateAutoGenerate(opts: AutoGenerateOptions): Promise<AutoGenerateHandle> {
  // One deadline shared across every candidate — passed into each
  // orchestrateGenerate call below so a slow candidate spends down the same
  // shared pool instead of each candidate getting its own fresh window
  // (which could let a handful of slow-failing candidates compound into
  // minutes, or let one slow candidate alone starve every one after it).
  const deadline = Date.now() + AUTO_WALL_CLOCK_BUDGET_MS;
  const waits: number[] = [];

  for (const model of opts.chain) {
    if (opts.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (Date.now() >= deadline) break;

    if (getEligibleAccounts(model, opts.backend).length === 0) {
      waits.push(minWaitMs(model, opts.backend));
      continue;
    }

    const body = await opts.buildBody(model);
    try {
      const handle = await orchestrateGenerate({ model, backend: opts.backend, body, signal: opts.signal, cooldownOnBadRequest: true, deadline });
      return { ...handle, modelUsed: model };
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // Unlike a pinned-model request, a bad_request here isn't necessarily
      // our translation bug — Google can reject an otherwise-valid request
      // for one specific model variant's own quirks (seen live: a plain
      // "-high" tier id 400ing on a minimal request that every other model
      // accepted fine). The caller asked for "a working model" over "fail
      // fast", so treat this like any other per-candidate failure and keep
      // walking the chain rather than aborting the whole request on it.
      waits.push(err instanceof NoAccountAvailableError ? err.retryAfterMs : minWaitMs(model, opts.backend));
    }
  }

  const retryAfterMs = waits.length > 0 ? Math.min(...waits) : 60_000;
  throw new NoAccountAvailableError(retryAfterMs);
}

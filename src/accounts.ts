import { randomUUID } from "node:crypto";
import { loadState, saveState } from "./store";
import { refreshAccessToken } from "./oauth";
import type { Account, ApiKeyAccount, Backend, OAuthAccount, StoreState } from "./types";

let state: StoreState = { version: 1, accounts: [], cooldowns: {} };
let loaded = false;

// In-memory only — which account is "sticky" for a given (backend, model).
// Deliberately not persisted: on restart, re-picking is cheap and correct.
const stickyPointer = new Map<string, string>();

// Single-flight de-dup for concurrent refreshes of the same account.
const refreshInFlight = new Map<string, Promise<string>>();

export async function initAccounts(): Promise<void> {
  if (loaded) return;
  state = await loadState();
  loaded = true;
}

async function persist(): Promise<void> {
  await saveState(state);
}

function cooldownKey(accountId: string, model: string): string {
  return `${accountId}::${model}`;
}

export function isOAuth(a: Account): a is OAuthAccount {
  return a.backend === "antigravity";
}
export function isApiKey(a: Account): a is ApiKeyAccount {
  return a.backend === "apikey";
}

/** Human-readable identity for logs/response headers — never the raw API key. */
export function accountIdentity(account: Account): string {
  return (isOAuth(account) ? account.email : account.label) || account.id;
}

export function listAccounts(): Account[] {
  return [...state.accounts];
}

export function getAccount(id: string): Account | undefined {
  return state.accounts.find((a) => a.id === id);
}

export async function addOAuthAccount(input: {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  email?: string;
  projectId?: string;
  endpointBase?: string;
}): Promise<OAuthAccount> {
  // Re-authenticating the same Google account replaces the old entry rather
  // than duplicating it.
  const existingIdx = state.accounts.findIndex(
    (a) => isOAuth(a) && input.email && a.email === input.email,
  );
  const account: OAuthAccount = {
    id: existingIdx >= 0 ? state.accounts[existingIdx]!.id : randomUUID(),
    backend: "antigravity",
    email: input.email,
    refreshToken: input.refreshToken,
    accessToken: input.accessToken,
    accessTokenExpiresAt: input.expiresAt,
    projectId: input.projectId,
    endpointBase: input.endpointBase,
    addedAt: existingIdx >= 0 ? state.accounts[existingIdx]!.addedAt : Date.now(),
    lastUsed: 0,
  };
  if (existingIdx >= 0) state.accounts[existingIdx] = account;
  else state.accounts.push(account);
  await persist();
  return account;
}

export async function addApiKeyAccount(apiKey: string, label?: string): Promise<ApiKeyAccount> {
  // Unlike OAuth (where re-adding the same email is a legitimate
  // re-authenticate-in-place operation), an API key is a static string with
  // nothing to refresh — a second add of the identical key is always just
  // an accidental duplicate, so reject it outright rather than creating a
  // second account entry.
  if (state.accounts.some((a) => isApiKey(a) && a.apiKey === apiKey)) {
    throw new Error("This API key has already been added.");
  }
  const account: ApiKeyAccount = {
    id: randomUUID(),
    backend: "apikey",
    apiKey,
    label,
    addedAt: Date.now(),
    lastUsed: 0,
  };
  state.accounts.push(account);
  await persist();
  return account;
}

export async function removeAccount(id: string): Promise<boolean> {
  const before = state.accounts.length;
  state.accounts = state.accounts.filter((a) => a.id !== id);
  for (const key of Object.keys(state.cooldowns)) {
    if (key.startsWith(`${id}::`)) delete state.cooldowns[key];
  }
  if (state.accounts.length !== before) {
    await persist();
    return true;
  }
  return false;
}

export async function markDisabled(id: string, reason: string): Promise<void> {
  const account = getAccount(id);
  if (!account) return;
  account.disabled = true;
  account.disabledReason = reason;
  await persist();
}

export async function reenable(id: string): Promise<void> {
  const account = getAccount(id);
  if (!account) return;
  account.disabled = false;
  account.disabledReason = undefined;
  await persist();
}

export async function markCooldown(accountId: string, model: string, retryAfterMs: number, reason: string): Promise<void> {
  state.cooldowns[cooldownKey(accountId, model)] = { until: Date.now() + retryAfterMs, reason };
  await persist();
}

function isCoolingDown(accountId: string, model: string): boolean {
  const cd = state.cooldowns[cooldownKey(accountId, model)];
  return !!cd && cd.until > Date.now();
}

// Only quota/rate-limit cooldowns can be countermanded by fresh quota data —
// a 404 ("model not available") or 400 ("model rejected this request") isn't
// about remaining allowance at all, so quotaInfo says nothing relevant to it.
const QUOTA_RECOVERABLE_REASONS = new Set(["rate limited (429)", "quota exhausted"]);

/**
 * Antigravity's model-discovery call already returns live per-model
 * remaining-quota info for free (no generation cost) — see oauth.ts's
 * fetchAvailableModels. When it reports real capacity for a model we're
 * still treating as cooling down, our own estimate is stale (Google already
 * reset it, or our fallback duration guessed too conservatively), so clear
 * it early rather than making rotation wait out the rest of our guess.
 * AI Studio has no equivalent endpoint, so this only ever applies to
 * Antigravity accounts.
 */
export async function reconcileCooldownsFromQuota(
  accountId: string,
  entries: Array<{ id: string; quotaInfo?: { remainingFraction?: number } }>,
): Promise<void> {
  let changed = false;
  for (const entry of entries) {
    const remaining = entry.quotaInfo?.remainingFraction;
    if (remaining === undefined || remaining <= 0) continue;
    const key = cooldownKey(accountId, entry.id);
    const cooldown = state.cooldowns[key];
    if (cooldown && QUOTA_RECOVERABLE_REASONS.has(cooldown.reason)) {
      delete state.cooldowns[key];
      changed = true;
    }
  }
  if (changed) await persist();
}

export function getEligibleAccounts(model: string, backend?: Backend): Account[] {
  return state.accounts.filter(
    (a) => !a.disabled && (!backend || a.backend === backend) && !isCoolingDown(a.id, model),
  );
}

/**
 * OAuth accounts have much bigger free-tier quota than AI Studio API keys, so
 * when both are eligible (i.e. `backend` wasn't pinned by the caller), prefer
 * OAuth and only reach for an API key once every eligible OAuth account for
 * this model is cooling down or disabled. Least-recently-used is still the
 * tiebreak within whichever pool is actually chosen.
 */
function selectNext(eligible: Account[]): Account {
  const oauthEligible = eligible.filter(isOAuth);
  const pool = oauthEligible.length > 0 ? oauthEligible : eligible;
  return [...pool].sort((a, b) => a.lastUsed - b.lastUsed)[0]!;
}

/** Sticky-until-failure selection for a (backend, model) pair. */
export function pickAccount(model: string, backend?: Backend): Account | null {
  const eligible = getEligibleAccounts(model, backend);
  if (eligible.length === 0) return null;

  const key = `${backend ?? "any"}:${model}`;
  const stickyId = stickyPointer.get(key);
  if (stickyId) {
    const sticky = eligible.find((a) => a.id === stickyId);
    // Stay stuck to the sticky pick — unless it's an API key that was only
    // ever chosen as a fallback, and an OAuth account has since become
    // eligible again. In that case switch back rather than continuing to
    // burn the scarce API-key quota while OAuth capacity sits idle.
    if (sticky && !(isApiKey(sticky) && eligible.some(isOAuth))) return sticky;
  }

  const next = selectNext(eligible);
  stickyPointer.set(key, next.id);
  return next;
}

/**
 * Excludes every account already tried this call (not just the most recent
 * failure) — a single-id exclusion let a request bounce back to an
 * already-failed account once a different one failed too, silently ending
 * the retry loop with eligible accounts still untried. See orchestrateGenerate.
 */
export function rotateAway(model: string, backend: Backend | undefined, failedAccountIds: ReadonlySet<string>): Account | null {
  const key = `${backend ?? "any"}:${model}`;
  const sticky = stickyPointer.get(key);
  if (sticky && failedAccountIds.has(sticky)) stickyPointer.delete(key);
  const eligible = getEligibleAccounts(model, backend).filter((a) => !failedAccountIds.has(a.id));
  if (eligible.length === 0) return null;
  const next = selectNext(eligible);
  stickyPointer.set(key, next.id);
  return next;
}

export async function updateOAuthProjectInfo(id: string, projectId: string, endpointBase: string): Promise<void> {
  const account = getAccount(id);
  if (!account || !isOAuth(account)) return;
  account.projectId = projectId;
  account.endpointBase = endpointBase;
  await persist();
}

export async function touch(accountId: string): Promise<void> {
  const account = getAccount(accountId);
  if (!account) return;
  account.lastUsed = Date.now();
  await persist();
}

/** Soonest time (ms from now) any account for this model becomes available again; 0 if one already is. */
export function minWaitMs(model: string, backend?: Backend): number {
  if (getEligibleAccounts(model, backend).length > 0) return 0;
  const relevant = state.accounts.filter((a) => !a.disabled && (!backend || a.backend === backend));
  const waits = relevant
    .map((a) => state.cooldowns[cooldownKey(a.id, model)])
    .filter((cd): cd is NonNullable<typeof cd> => !!cd)
    .map((cd) => Math.max(0, cd.until - Date.now()));
  return waits.length > 0 ? Math.min(...waits) : 60_000;
}

const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/** Returns a valid access token for an OAuth account, refreshing (single-flight) if it's expired or near-expiry. */
export async function getValidAccessToken(account: OAuthAccount): Promise<string> {
  const fresh = account.accessToken && account.accessTokenExpiresAt && account.accessTokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS > Date.now();
  if (fresh) return account.accessToken!;

  const inFlight = refreshInFlight.get(account.id);
  if (inFlight) return inFlight;

  const task = (async () => {
    try {
      const result = await refreshAccessToken(account.refreshToken);
      const current = getAccount(account.id);
      if (current && isOAuth(current)) {
        current.accessToken = result.accessToken;
        current.accessTokenExpiresAt = result.expiresAt;
        if (result.refreshToken) current.refreshToken = result.refreshToken;
        current.disabled = false;
        current.disabledReason = undefined;
        await persist();
      }
      return result.accessToken;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 400 || status === 401) {
        await markDisabled(account.id, "Refresh token rejected (invalid_grant) — needs re-authentication.");
      }
      throw err;
    } finally {
      refreshInFlight.delete(account.id);
    }
  })();

  refreshInFlight.set(account.id, task);
  return task;
}

export function redact(account: Account): Record<string, unknown> {
  const base = {
    id: account.id,
    backend: account.backend,
    label: account.label,
    addedAt: account.addedAt,
    lastUsed: account.lastUsed,
    disabled: !!account.disabled,
    disabledReason: account.disabledReason,
  };
  if (isOAuth(account)) {
    return { ...base, email: account.email, projectId: account.projectId };
  }
  const key = account.apiKey;
  return { ...base, apiKeyMasked: key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "****" };
}

export function activeCooldowns(): Array<{ accountId: string; model: string; until: number; reason: string }> {
  const now = Date.now();
  return Object.entries(state.cooldowns)
    .filter(([, cd]) => cd.until > now)
    .map(([key, cd]) => {
      const [accountId, model] = key.split("::");
      return { accountId: accountId!, model: model!, until: cd.until, reason: cd.reason };
    });
}

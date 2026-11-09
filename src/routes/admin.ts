import {
  generatePkce,
  buildAuthUrl,
  newState,
  waitForOAuthCallback,
  exchangeCode,
  loadCodeAssistProject,
  fetchUserEmail,
  fetchAvailableModels,
  type AntigravityModelEntry,
} from "../oauth";
import {
  addOAuthAccount,
  addApiKeyAccount,
  removeAccount,
  listAccounts,
  getAccount,
  redact,
  reenable,
  markDisabled,
  activeCooldowns,
  isOAuth,
  isApiKey,
  getValidAccessToken,
} from "../accounts";
import { ANTIGRAVITY_ENDPOINTS } from "../constants";
import { openAIErrorResponse } from "../errors";
import { listAvailableModels } from "../models";
import { validateApiKey } from "../transports/apikey";

interface PendingOAuth {
  status: "pending" | "done" | "error";
  authUrl: string;
  email?: string;
  error?: string;
}
const pendingOAuth = new Map<string, PendingOAuth>();

// Distinguishes a user-initiated disable (UI keeps this exact string to
// render it as a neutral "disabled" badge) from an auto-disable due to a
// genuine account error (which keeps the red "needs attention" badge).
const MANUAL_DISABLE_REASON = "Disabled manually.";

// The OAuth callback can only ever be received on one fixed local port
// (Google's registered redirect_uri isn't dynamic), so only one flow can be
// in flight at a time. Without this guard, two near-simultaneous
// "Add account" clicks (e.g. a double-click) each mint their own `state`;
// the second's callback-server bind loses the race, but the client still
// gets its authUrl and may complete sign-in against it — and the callback
// that actually arrives is then checked against a DIFFERENT (first) state,
// which reads to the user as "this link has expired". Reusing the in-flight
// flow instead of racing a second one avoids that entirely.
let activeState: string | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function startOAuth(): Response {
  if (activeState) {
    const existing = pendingOAuth.get(activeState);
    if (existing?.status === "pending") {
      return json({ authUrl: existing.authUrl, state: activeState });
    }
    activeState = null; // stale — fall through and start a fresh flow
  }

  const { verifier, challenge } = generatePkce();
  const state = newState();
  const authUrl = buildAuthUrl(challenge, state);
  pendingOAuth.set(state, { status: "pending", authUrl });
  activeState = state;

  // Fire-and-forget: resolves once Google redirects back to the fixed local
  // callback port. The client polls /admin/oauth/status/:state for progress.
  void (async () => {
    try {
      const code = await waitForOAuthCallback(state);
      const tokens = await exchangeCode(code, verifier);
      const email = await fetchUserEmail(tokens.accessToken);
      const project = await loadCodeAssistProject(tokens.accessToken).catch(() => undefined);
      await addOAuthAccount({
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        email,
        projectId: project?.projectId,
        endpointBase: project?.endpointBase,
      });
      pendingOAuth.set(state, { status: "done", authUrl, email });
    } catch (err) {
      pendingOAuth.set(state, { status: "error", authUrl, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (activeState === state) activeState = null;
    }
  })();

  return json({ authUrl, state });
}

function oauthStatus(state: string): Response {
  const entry = pendingOAuth.get(state);
  if (!entry) return json({ status: "unknown" }, 404);
  return json(entry);
}

// Short-lived so opening the quota panel a few times in a row doesn't spam
// the upstream endpoint, but still refreshes often enough to be trustworthy
// (quota is live account state, not something to cache for long).
const QUOTA_CACHE_TTL_MS = 30_000;
const quotaCache = new Map<string, { models: AntigravityModelEntry[]; expiresAt: number }>();

async function accountModels(accountId: string): Promise<Response> {
  const account = getAccount(accountId);
  if (!account) return json({ error: "Account not found" }, 404);
  if (!isOAuth(account)) {
    return json({ models: [], note: "Quota info is only available for Antigravity (OAuth) accounts." });
  }

  const cached = quotaCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return json({ models: cached.models });

  try {
    const token = await getValidAccessToken(account);
    const endpointBase = account.endpointBase || ANTIGRAVITY_ENDPOINTS[0]!;
    const models = await fetchAvailableModels(token, account.projectId ?? "", endpointBase);
    quotaCache.set(accountId, { models, expiresAt: Date.now() + QUOTA_CACHE_TTL_MS });
    return json({ models });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}

/**
 * On-demand health check for an AI Studio key — accounts are otherwise only
 * ever tried lazily (whichever one real traffic happens to pick), so a bad
 * key already in the pool can sit shown as "active" indefinitely if it's
 * never selected. Bidirectional: disables on a genuine account-level
 * failure, re-enables if a previously-disabled key now checks out (e.g. the
 * user rotated in a corrected key without removing/re-adding the account).
 */
async function testApiKeyAccount(accountId: string): Promise<Response> {
  const account = getAccount(accountId);
  if (!account) return json({ error: "Account not found" }, 404);
  if (!isApiKey(account)) {
    return json({ error: "Testing is only available for AI Studio API key accounts." }, 400);
  }

  const check = await validateApiKey(account.apiKey);
  if (check.ok) {
    if (account.disabled) await reenable(accountId);
    return json({ ok: true });
  }
  if (check.disable) await markDisabled(accountId, check.reason!);
  return json({ ok: false, reason: check.reason });
}

export async function handleAdmin(req: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["admin", ...]

  if (req.method === "GET" && parts[1] === "accounts" && parts.length === 2) {
    // Included so the UI can tell "cooling down on some models" (still fully
    // usable) apart from "cooling down on every model this backend serves"
    // (genuinely exhausted right now) without an extra round-trip.
    const modelsByBackend: Record<string, string[]> = {};
    for (const m of await listAvailableModels()) (modelsByBackend[m.backend] ??= []).push(m.id);
    return json({ accounts: listAccounts().map(redact), cooldowns: activeCooldowns(), modelsByBackend });
  }

  if (req.method === "POST" && parts[1] === "accounts" && parts[2] === "apikey" && parts.length === 3) {
    const body = (await req.json().catch(() => null)) as { apiKey?: string; label?: string } | null;
    if (!body?.apiKey?.trim()) return openAIErrorResponse(400, "apiKey is required");
    let account;
    try {
      account = await addApiKeyAccount(body.apiKey.trim(), body.label?.trim());
    } catch (err) {
      return openAIErrorResponse(409, err instanceof Error ? err.message : "Could not add this API key.");
    }
    // Catch a bad key immediately rather than leaving it to silently sit as
    // "active" until real traffic happens to pick it — accounts are only
    // ever tried lazily, on use.
    const check = await validateApiKey(account.apiKey);
    if (!check.ok && check.disable) await markDisabled(account.id, check.reason!);
    return json({ account: redact(getAccount(account.id) ?? account) });
  }

  if (req.method === "DELETE" && parts[1] === "accounts" && parts.length === 3) {
    const ok = await removeAccount(parts[2]!);
    return ok ? json({ removed: true }) : json({ removed: false }, 404);
  }

  if (req.method === "POST" && parts[1] === "accounts" && parts[3] === "reenable" && parts.length === 4) {
    await reenable(parts[2]!);
    return json({ ok: true });
  }

  if (req.method === "POST" && parts[1] === "accounts" && parts[3] === "disable" && parts.length === 4) {
    await markDisabled(parts[2]!, MANUAL_DISABLE_REASON);
    return json({ ok: true });
  }

  if (req.method === "GET" && parts[1] === "accounts" && parts[3] === "models" && parts.length === 4) {
    return accountModels(parts[2]!);
  }

  if (req.method === "GET" && parts[1] === "accounts" && parts[3] === "key" && parts.length === 4) {
    // Deliberately not part of the regular /admin/accounts payload (which
    // is polled every 10s and rendered from) — only returned on this
    // explicit, single-purpose request, so the real key sits in the page's
    // memory/DOM only for the moment a copy is actually requested.
    const account = getAccount(parts[2]!);
    if (!account) return json({ error: "Account not found" }, 404);
    if (!isApiKey(account)) return json({ error: "Only API key accounts have a key to reveal." }, 400);
    return json({ apiKey: account.apiKey });
  }

  if (req.method === "POST" && parts[1] === "accounts" && parts[3] === "test" && parts.length === 4) {
    return testApiKeyAccount(parts[2]!);
  }

  if (req.method === "POST" && parts[1] === "oauth" && parts[2] === "start" && parts.length === 3) {
    return startOAuth();
  }

  if (req.method === "GET" && parts[1] === "oauth" && parts[2] === "status" && parts.length === 4) {
    return oauthStatus(parts[3]!);
  }

  return openAIErrorResponse(404, `Unknown admin route: ${req.method} ${url.pathname}`);
}

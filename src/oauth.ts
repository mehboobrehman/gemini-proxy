import { randomBytes, createHash, randomUUID } from "node:crypto";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_OAUTH_CALLBACK_PORT,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  ANTIGRAVITY_ENDPOINTS,
  ANTIGRAVITY_USER_AGENT,
} from "./constants";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl(challenge: string, state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function exchangeCode(code: string, verifier: string): Promise<TokenExchangeResult> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  if (!json.refresh_token) throw new Error("Google did not return a refresh_token (already consented without prompt=consent?)");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

export interface RefreshResult {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string; // present only if Google rotated it
}

export async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Token refresh failed: ${res.status} ${text}`);
    (err as any).status = res.status;
    (err as any).body = text;
    throw err;
  }
  const json = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    refreshToken: json.refresh_token,
  };
}

export async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { email?: string };
    return json.email;
  } catch {
    return undefined;
  }
}

export interface LoadCodeAssistResult {
  endpointBase: string;
  projectId: string;
}

/** Tries each Antigravity endpoint in order, returns the first that answers with a project id (or empty string if the account has none). */
export async function loadCodeAssistProject(accessToken: string): Promise<LoadCodeAssistResult> {
  let lastError: string | undefined;
  for (const base of ANTIGRAVITY_ENDPOINTS) {
    try {
      const res = await fetch(`${base}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": ANTIGRAVITY_USER_AGENT,
        },
        // Matches a real Antigravity 2.3.1 client exactly (verified via
        // mitmproxy capture 2026-07-25) — no Accept header, and this minimal
        // body rather than the fuller IDE_UNSPECIFIED/PLATFORM_UNSPECIFIED
        // shape an older reference implementation used.
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        lastError = `${base}: HTTP ${res.status} ${await res.text().catch(() => "")}`;
        continue;
      }
      const data = (await res.json()) as { cloudaicompanionProject?: string | { id?: string } };
      const project = data.cloudaicompanionProject;
      const projectId = typeof project === "string" ? project : project?.id ?? "";
      return { endpointBase: base, projectId };
    } catch (err) {
      lastError = `${base}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(`loadCodeAssist failed on all endpoints. Last error: ${lastError}`);
}

export interface AntigravityModelEntry {
  id: string;
  displayName?: string;
  maxTokens?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
  recommended?: boolean;
  /** remainingFraction is 0-1; resetTime is an ISO timestamp for when quota refills. */
  quotaInfo?: { remainingFraction?: number; resetTime?: string };
}

// Internal/experimental placeholder ids that show up in fetchAvailableModels
// but aren't real user-facing models — same exclusion list CLIProxyAPI uses.
const ANTIGRAVITY_INTERNAL_MODEL_IDS = new Set([
  "chat_20706",
  "chat_23310",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
]);

/**
 * Live model discovery — verified 2026-07-25 against a real free-tier
 * account. Google renumbers Antigravity's model lineup often enough that a
 * hand-curated static list goes stale within hours; this is the actual
 * source of truth the Antigravity client itself uses; a static list
 * (ANTIGRAVITY_MODELS in constants.ts) is kept only as a fallback for when
 * this call fails (offline, endpoint down).
 */
export async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
  endpointBase: string,
): Promise<AntigravityModelEntry[]> {
  const res = await fetch(`${endpointBase}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": ANTIGRAVITY_USER_AGENT,
    },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`fetchAvailableModels failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as {
    models?: Record<
      string,
      {
        displayName?: string;
        maxTokens?: number;
        maxOutputTokens?: number;
        supportsThinking?: boolean;
        recommended?: boolean;
        quotaInfo?: { remainingFraction?: number; resetTime?: string };
      }
    >;
  };

  const entries: AntigravityModelEntry[] = [];
  for (const [id, m] of Object.entries(data.models ?? {})) {
    if (ANTIGRAVITY_INTERNAL_MODEL_IDS.has(id)) continue;
    entries.push({
      id,
      displayName: m.displayName,
      maxTokens: m.maxTokens,
      maxOutputTokens: m.maxOutputTokens,
      supportsThinking: m.supportsThinking,
      recommended: m.recommended,
      quotaInfo: m.quotaInfo,
    });
  }
  return entries;
}

/**
 * Starts a one-shot local HTTP server on the fixed Antigravity redirect port
 * and resolves with the authorization code once Google redirects back to it.
 * Tolerant of stray hits (stale browser tabs from a previous run, favicon
 * probes) — only resolves on a callback whose `state` matches.
 */
export function waitForOAuthCallback(expectedState: string, timeoutMs = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: ReturnType<typeof Bun.serve> | undefined;
    const timer = setTimeout(() => {
      server?.stop(true);
      reject(new Error("Timed out waiting for the OAuth redirect."));
    }, timeoutMs);

    try {
      server = Bun.serve({
        port: ANTIGRAVITY_OAUTH_CALLBACK_PORT,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname !== "/oauth-callback") return new Response("not found", { status: 404 });

          const code = url.searchParams.get("code");
          const gotState = url.searchParams.get("state");
          const err = url.searchParams.get("error");

          if (err) {
            return new Response(
              `<html><body>OAuth error: ${err}. You can close this tab and try again from the proxy's UI.</body></html>`,
              { status: 400, headers: { "content-type": "text/html" } },
            );
          }
          if (!code || gotState !== expectedState) {
            return new Response(
              "<html><body>This link has expired — go back to the proxy UI and click “Add account” again.</body></html>",
              { status: 400, headers: { "content-type": "text/html" } },
            );
          }

          clearTimeout(timer);
          setTimeout(() => server?.stop(), 500);
          resolve(code);
          return new Response(
            "<html><body>Signed in — you can close this tab and return to the proxy.</body></html>",
            { headers: { "content-type": "text/html" } },
          );
        },
      });
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      const busy = message.includes("EADDRINUSE") || message.includes("address already in use");
      reject(
        new Error(
          busy
            ? `Port ${ANTIGRAVITY_OAUTH_CALLBACK_PORT} (needed for the OAuth redirect) is already in use by another process — close whatever's using it and try again.`
            : `Failed to start the local OAuth callback listener: ${message}`,
        ),
      );
    }
  });
}

export function newState(): string {
  return randomUUID();
}

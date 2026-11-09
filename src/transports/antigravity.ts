import { randomUUID } from "node:crypto";
import { ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_USER_AGENT } from "../constants";
import { getValidAccessToken, updateOAuthProjectInfo } from "../accounts";
import { loadCodeAssistProject } from "../oauth";
import { classifyHttpError } from "../errors";
import { parseSSE } from "../sse";
import { withConnectTimeout } from "../timeout";
import type { GeminiRequestBody, GeminiResponse, OAuthAccount } from "../types";

async function ensureProject(account: OAuthAccount, accessToken: string): Promise<{ endpointBase: string; projectId: string }> {
  if (account.endpointBase && account.projectId !== undefined) {
    return { endpointBase: account.endpointBase, projectId: account.projectId };
  }
  const result = await loadCodeAssistProject(accessToken);
  await updateOAuthProjectInfo(account.id, result.projectId, result.endpointBase);
  return result;
}

function sessionId(): string {
  return "-" + Math.floor(Math.random() * 9_000_000_000_000_000_000).toString();
}

/**
 * Purely decorative envelope/request fields a real Antigravity client
 * always sends (verified via mitmproxy capture 2026-07-25: top-level
 * `requestType` and `request.labels` with execution/trajectory ids +
 * `used_claude*`/`used_non_gemini_model` flags). None of this is visible to
 * the model or returned to the caller — it's client-generated telemetry
 * Google's backend has no way to validate against ground truth, the same
 * way our own requestId/sessionId already are. Deliberately NOT included:
 * `labels.model_enum`, which the real client sets to an internal per-model
 * code we have no correct mapping for — a wrong guess would look more
 * suspicious than simply omitting the field, and every request in this
 * project's testing has succeeded without it.
 */
function decorativeLabels(model: string, contentsLength: number) {
  const lower = model.toLowerCase();
  const usedClaude = lower.includes("claude");
  return {
    last_execution_id: randomUUID(),
    last_step_index: String(Math.max(1, contentsLength)),
    trajectory_id: randomUUID(),
    used_claude: String(usedClaude),
    used_claude_conservative: String(usedClaude),
    used_non_gemini_model: String(!lower.startsWith("gemini")),
  };
}

async function* unwrapStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<GeminiResponse> {
  for await (const payload of parseSSE(stream)) {
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { response?: GeminiResponse };
      yield (parsed.response ?? (parsed as unknown as GeminiResponse));
    } catch {
      // Skip malformed events rather than aborting an otherwise-good stream.
    }
  }
}

export async function generateAntigravity(
  account: OAuthAccount,
  model: string,
  body: GeminiRequestBody,
  opts: { signal?: AbortSignal },
): Promise<AsyncGenerator<GeminiResponse>> {
  const accessToken = await getValidAccessToken(account);
  let { endpointBase, projectId } = await ensureProject(account, accessToken);

  const envelope = {
    project: projectId || undefined,
    model,
    userAgent: "antigravity",
    requestId: "agent-" + randomUUID(),
    requestType: "agent",
    request: { ...body, sessionId: sessionId(), labels: decorativeLabels(model, body.contents.length) },
  };

  // No Accept header, matching a real Antigravity client exactly (verified
  // via mitmproxy capture 2026-07-25) — it relies on `?alt=sse` alone to
  // signal the streaming response format.
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": ANTIGRAVITY_USER_AGENT,
  };
  const payload = JSON.stringify(envelope);

  let { signal, clearConnectTimeout } = withConnectTimeout(opts.signal);
  let res = await fetch(`${endpointBase}/v1internal:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers,
    body: payload,
    signal,
  });
  clearConnectTimeout();

  // If the cached endpoint starts failing server-side, try the other one
  // before surfacing an error (and re-cache whichever one works).
  if (!res.ok && res.status >= 500) {
    for (const fallback of ANTIGRAVITY_ENDPOINTS) {
      if (fallback === endpointBase) continue;
      ({ signal, clearConnectTimeout } = withConnectTimeout(opts.signal));
      const retry = await fetch(`${fallback}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers,
        body: payload,
        signal,
      });
      clearConnectTimeout();
      if (retry.ok) {
        endpointBase = fallback;
        await updateOAuthProjectInfo(account.id, projectId, fallback);
        res = retry;
        break;
      }
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw classifyHttpError(res.status, text);
  }

  return unwrapStream(res.body!);
}

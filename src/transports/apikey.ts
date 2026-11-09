import { AI_STUDIO_BASE } from "../constants";
import { classifyHttpError, disabledReasonFor } from "../errors";
import { parseSSE } from "../sse";
import { withConnectTimeout } from "../timeout";
import type { ApiKeyAccount, GeminiRequestBody, GeminiResponse } from "../types";

async function* unwrapStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<GeminiResponse> {
  for await (const payload of parseSSE(stream)) {
    if (!payload || payload === "[DONE]") continue;
    try {
      yield JSON.parse(payload) as GeminiResponse;
    } catch {
      // Skip malformed events rather than aborting an otherwise-good stream.
    }
  }
}

export async function generateApiKey(
  account: ApiKeyAccount,
  model: string,
  body: GeminiRequestBody,
  opts: { signal?: AbortSignal },
): Promise<AsyncGenerator<GeminiResponse>> {
  const url = `${AI_STUDIO_BASE}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const { signal, clearConnectTimeout } = withConnectTimeout(opts.signal);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": account.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  // Headers arrived — from here on this request is only subject to the
  // caller's own abort (still wired into `signal`), never the connect timer.
  clearConnectTimeout();

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw classifyHttpError(res.status, text);
  }

  return unwrapStream(res.body!);
}

export interface ApiKeyValidation {
  ok: boolean;
  /** Only set when !ok. True for account-level problems (bad/revoked key,
   *  no permission) that should disable the account; false for transient
   *  failures (rate limit, upstream 5xx, network) that shouldn't — those
   *  aren't evidence the key itself is bad, just that this one check hit a
   *  blip, so disabling on the strength of it would be a false positive. */
  disable?: boolean;
  reason?: string;
}

/**
 * Up-front health check for an AI Studio key. Used both when a key is first
 * added and on demand via the "test" button, so a bad key gets caught
 * immediately instead of silently sitting as "active" until it happens to be
 * picked by real traffic (accounts aren't proactively tried otherwise, only
 * on use).
 *
 * Deliberately a real (trivial, ~1-token) generateContent call rather than
 * the cheaper /v1beta/models list endpoint: verified live that the two give
 * different answers — a key whose project was denied generation access
 * (403 on generateContent) still lists models fine (200 OK), so the list
 * endpoint would have reported a broken key as healthy.
 */
export async function validateApiKey(apiKey: string): Promise<ApiKeyValidation> {
  try {
    const res = await fetch(`${AI_STUDIO_BASE}/v1beta/models/gemini-flash-latest:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => "");
    const err = classifyHttpError(res.status, text);
    const disableReason = disabledReasonFor(err);
    return disableReason
      ? { ok: false, disable: true, reason: disableReason }
      : { ok: false, disable: false, reason: `${err.message} (${res.status}).` };
  } catch (err) {
    return { ok: false, disable: false, reason: err instanceof Error ? err.message : "Could not reach Google's API." };
  }
}

/** Live model discovery for an AI Studio key — used to populate /v1/models. */
export async function listApiKeyModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(`${AI_STUDIO_BASE}/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
    };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((id) => id.startsWith("gemini"))
      .sort();
  } catch {
    return [];
  }
}

import { resolveModel, isKnownModel } from "../models";
import { orchestrateGenerate } from "../orchestrate";
import { accountIdentity } from "../accounts";
import { SAFETY_SETTINGS } from "../translate/openai-to-gemini";
import { NoAccountAvailableError, openAIErrorResponse } from "../errors";
import type { GeminiRequestBody, GeminiResponse } from "../types";

interface ImageGenerationRequest {
  model?: string;
  prompt?: string;
  n?: number;
  size?: string;
  response_format?: string;
}

/** Collects every inlineData part across a (possibly multi-event) response into base64 strings. Images-API responses are single-shot JSON, so this always drains the full stream rather than exposing it incrementally. */
async function collectImages(events: AsyncIterable<GeminiResponse>): Promise<string[]> {
  const images: string[] = [];
  for await (const gemini of events) {
    for (const part of gemini.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) images.push(part.inlineData.data);
    }
  }
  return images;
}

/**
 * OpenAI Images API (`/v1/images/generations`) — a completely different wire
 * shape from chat completions (`{data:[{b64_json}]}` vs `message.images`).
 * Some OpenAI-compatible SDK layers (e.g. Vercel AI SDK's
 * `@ai-sdk/openai-compatible` image model) only ever speak this endpoint,
 * never chat completions, so image-capable Gemini models need to be
 * reachable here too — not just through /v1/chat/completions.
 *
 * Always returns `b64_json` regardless of the requested `response_format`:
 * this proxy has no public file host to hand back a real `url`, and
 * b64_json is what every client actually needs the bytes for anyway.
 */
export async function handleImageGenerations(req: Request): Promise<Response> {
  let parsed: ImageGenerationRequest;
  try {
    parsed = (await req.json()) as ImageGenerationRequest;
  } catch {
    return openAIErrorResponse(400, "Invalid JSON body");
  }
  if (!parsed.model || !parsed.prompt) {
    return openAIErrorResponse(400, "`model` and `prompt` are required");
  }

  const resolved = resolveModel(parsed.model);
  const { model, backend } = resolved;

  if (!(await isKnownModel(resolved))) {
    return openAIErrorResponse(404, `Model "${parsed.model}" is not available on any configured account.`, "invalid_request_error", "model_not_found");
  }

  const n = Math.min(Math.max(parsed.n ?? 1, 1), 4);

  const body: GeminiRequestBody = {
    contents: [{ role: "user", parts: [{ text: parsed.prompt }] }],
    safetySettings: SAFETY_SETTINGS,
  };

  try {
    const results = await Promise.all(
      Array.from({ length: n }, () => orchestrateGenerate({ model, backend, body, signal: req.signal })),
    );
    const images = (await Promise.all(results.map((r) => collectImages(r.events)))).flat();

    if (images.length === 0) {
      return openAIErrorResponse(
        502,
        `Model "${parsed.model}" did not return an image — it may not be an image-generation model, or the prompt was refused.`,
        "upstream_error",
      );
    }

    // n images can land on different accounts (each orchestrateGenerate call
    // picks independently) — list every distinct one that contributed rather
    // than just the first, so the header doesn't silently hide a fan-out.
    const servedVia = [...new Set(results.map((r) => `${r.accountUsed.backend}:${accountIdentity(r.accountUsed)}`))].join(",");

    return new Response(
      JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: images.map((b64Json) => ({ b64_json: b64Json })),
      }),
      { headers: { "content-type": "application/json", "x-served-via": servedVia } },
    );
  } catch (err) {
    if (err instanceof NoAccountAvailableError) {
      return new Response(JSON.stringify({ error: { message: err.message, type: "insufficient_quota" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(Math.ceil(err.retryAfterMs / 1000)) },
      });
    }
    return openAIErrorResponse(502, err instanceof Error ? err.message : "Upstream request failed", "upstream_error");
  }
}

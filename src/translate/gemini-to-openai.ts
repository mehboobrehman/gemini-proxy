import { randomUUID } from "node:crypto";
import type { GeminiResponse, GeminiUsageMetadata, OpenAIUsage } from "../types";

export function mapFinishReason(reason: string | undefined, anyToolCalls: boolean): string {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    case "STOP":
    case "MALFORMED_FUNCTION_CALL":
    case undefined:
    default:
      return anyToolCalls ? "tool_calls" : "stop";
  }
}

export function usageFromGemini(u: GeminiUsageMetadata): OpenAIUsage {
  const completion = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  const usage: OpenAIUsage = {
    prompt_tokens: u.promptTokenCount ?? 0,
    completion_tokens: completion,
    total_tokens: u.totalTokenCount ?? (u.promptTokenCount ?? 0) + completion,
  };
  if (u.thoughtsTokenCount) usage.completion_tokens_details = { reasoning_tokens: u.thoughtsTokenCount };
  if (u.cachedContentTokenCount) usage.prompt_tokens_details = { cached_tokens: u.cachedContentTokenCount };
  return usage;
}

/**
 * Gemini 3 requires each functionCall replayed on a later turn to carry back
 * the exact `thoughtSignature` it was originally emitted with, or the
 * request 400s ("Function call is missing a thought_signature"). The OpenAI
 * wire format has no field for this, and clients only round-trip
 * `tool_call.id` verbatim (message content gets re-typed/re-serialized by
 * many client libraries, dropping unknown fields) — so we smuggle the
 * signature through the id itself. See decodeToolCallId in
 * openai-to-gemini.ts for the reverse direction.
 */
export function encodeToolCallId(thoughtSignature: string | undefined): string {
  const base = "call_" + randomUUID().replace(/-/g, "").slice(0, 20);
  if (!thoughtSignature) return base;
  return `${base}~${Buffer.from(thoughtSignature, "utf-8").toString("base64url")}`;
}

interface OpenAIImagePart {
  type: "image_url";
  image_url: { url: string };
}

/** Image-generation models (e.g. gemini-3.1-flash-image) return the image as an inlineData part rather than text — matches the `message.images` / `delta.images` convention used by OpenAI's own chat-based image-gen models (gpt-image-in-chat, Nano Banana, etc). */
function inlineDataToImagePart(inlineData: { mimeType: string; data: string }): OpenAIImagePart {
  return { type: "image_url", image_url: { url: `data:${inlineData.mimeType};base64,${inlineData.data}` } };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface StreamTranslator {
  /** Feed one unwrapped Gemini SSE event; returns 0+ already-JSON.stringify'd `data: ...` SSE lines. */
  feed(gemini: GeminiResponse): string[];
  /** Call once the upstream stream ends normally; emits a synthesized finish chunk if none was seen, an optional usage chunk, and `data: [DONE]`. */
  finalizeLines(): string[];
  /**
   * Call instead of finalizeLines() when the upstream stream failed before
   * Gemini ever sent a real finishReason. Never synthesizes the "stop"/
   * "tool_calls" finish chunk finalizeLines() would — doing so here would
   * misrepresent a truncated response as a clean one. Always emits the bare
   * OpenAI-style `error` frame, even if content was already streamed to the
   * client: "commit-on-first-content" (see orchestrate.ts) means we can
   * never retry once content has started, but that's no reason to also hide
   * the failure — a caller has no way to tell a truncated response from a
   * deliberately short one unless this says so.
   */
  finalizeWithError(message: string): string[];
}

export function createOpenAIStreamTranslator(model: string, toolNameMap: Map<string, string>, includeUsage: boolean): StreamTranslator {
  const id = "chatcmpl-" + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let toolCallIndex = 0;
  let anyToolCalls = false;
  let lastUsage: GeminiUsageMetadata | undefined;
  let finished = false;

  function baseChunk(): Record<string, unknown> {
    return { id, object: "chat.completion.chunk", created, model };
  }

  function emit(delta: Record<string, unknown>, finishReason: string | null): string {
    if (!sentRole) {
      delta = { role: "assistant", ...delta };
      sentRole = true;
    }
    return `data: ${JSON.stringify({ ...baseChunk(), choices: [{ index: 0, delta, finish_reason: finishReason }] })}`;
  }

  function feed(gemini: GeminiResponse): string[] {
    const lines: string[] = [];
    if (gemini.usageMetadata) lastUsage = gemini.usageMetadata;

    const candidate = gemini.candidates?.[0];

    if (!candidate) {
      if (gemini.promptFeedback?.blockReason) {
        lines.push(emit({}, "content_filter"));
        finished = true;
      }
      return lines;
    }

    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall) {
        anyToolCalls = true;
        const originalName = toolNameMap.get(part.functionCall.name) ?? part.functionCall.name;
        lines.push(
          emit(
            {
              tool_calls: [
                {
                  index: toolCallIndex++,
                  id: encodeToolCallId(part.thoughtSignature),
                  type: "function",
                  function: { name: originalName, arguments: JSON.stringify(part.functionCall.args ?? {}) },
                },
              ],
            },
            null,
          ),
        );
        continue;
      }
      if (part.thought) {
        if (part.text) lines.push(emit({ reasoning_content: part.text }, null));
        continue;
      }
      if (part.inlineData) {
        lines.push(emit({ images: [inlineDataToImagePart(part.inlineData)] }, null));
        continue;
      }
      if (part.text) lines.push(emit({ content: part.text }, null));
    }

    if (candidate.finishReason) {
      lines.push(emit({}, mapFinishReason(candidate.finishReason, anyToolCalls)));
      finished = true;
    }

    return lines;
  }

  function finalizeLines(): string[] {
    const lines: string[] = [];
    if (!finished) {
      lines.push(emit({}, anyToolCalls ? "tool_calls" : "stop"));
      finished = true;
    }
    if (includeUsage && lastUsage) {
      lines.push(`data: ${JSON.stringify({ ...baseChunk(), choices: [], usage: usageFromGemini(lastUsage) })}`);
    }
    lines.push("data: [DONE]");
    return lines;
  }

  function finalizeWithError(message: string): string[] {
    const lines: string[] = [];
    if (!finished) {
      lines.push(`data: ${JSON.stringify({ error: { message } })}`);
      finished = true;
    }
    lines.push("data: [DONE]");
    return lines;
  }

  return { feed, finalizeLines, finalizeWithError };
}

// ---------------------------------------------------------------------------
// Non-streaming aggregation — reuses the same upstream stream, just collects
// it fully before responding, so there's one translation code path.
// ---------------------------------------------------------------------------

export async function aggregateGeminiToOpenAI(
  events: AsyncIterable<GeminiResponse>,
  model: string,
  toolNameMap: Map<string, string>,
): Promise<Record<string, unknown>> {
  let content = "";
  let reasoning = "";
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  const images: OpenAIImagePart[] = [];
  let finishReason: string | undefined;
  let lastUsage: GeminiUsageMetadata | undefined;
  let blocked = false;

  for await (const gemini of events) {
    if (gemini.usageMetadata) lastUsage = gemini.usageMetadata;
    const candidate = gemini.candidates?.[0];
    if (!candidate) {
      if (gemini.promptFeedback?.blockReason) blocked = true;
      continue;
    }
    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall) {
        const originalName = toolNameMap.get(part.functionCall.name) ?? part.functionCall.name;
        toolCalls.push({
          id: encodeToolCallId(part.thoughtSignature),
          type: "function",
          function: { name: originalName, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        });
      } else if (part.thought) {
        if (part.text) reasoning += part.text;
      } else if (part.inlineData) {
        images.push(inlineDataToImagePart(part.inlineData));
      } else if (part.text) {
        content += part.text;
      }
    }
    if (candidate.finishReason) finishReason = candidate.finishReason;
  }

  const anyToolCalls = toolCalls.length > 0;
  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (anyToolCalls) message.tool_calls = toolCalls;
  if (images.length > 0) message.images = images;

  return {
    id: "chatcmpl-" + randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: blocked ? "content_filter" : mapFinishReason(finishReason, anyToolCalls),
      },
    ],
    usage: lastUsage ? usageFromGemini(lastUsage) : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

import { translateOpenAIToGemini, TranslationError } from "../translate/openai-to-gemini";
import { createOpenAIStreamTranslator, aggregateGeminiToOpenAI } from "../translate/gemini-to-openai";
import { resolveModel, isKnownModel } from "../models";
import { AUTO_MODEL_ID, buildAutoChain } from "../auto";
import { orchestrateGenerate, orchestrateAutoGenerate, type GenerateHandle } from "../orchestrate";
import { accountIdentity } from "../accounts";
import { NoAccountAvailableError, TransportError, openAIErrorResponse } from "../errors";
import type { OpenAIChatRequest } from "../types";

export async function handleChatCompletions(req: Request): Promise<Response> {
  let parsed: OpenAIChatRequest;
  try {
    parsed = (await req.json()) as OpenAIChatRequest;
  } catch {
    return openAIErrorResponse(400, "Invalid JSON body");
  }
  if (!parsed.model || !Array.isArray(parsed.messages)) {
    return openAIErrorResponse(400, "`model` and `messages` are required");
  }

  const resolved = resolveModel(parsed.model);
  const { model, backend } = resolved;
  const isAuto = model === AUTO_MODEL_ID;

  if (!isAuto && !(await isKnownModel(resolved))) {
    return openAIErrorResponse(404, `Model "${parsed.model}" is not available on any configured account.`, "invalid_request_error", "model_not_found");
  }

  let handle: GenerateHandle;
  let modelUsed = model;
  let toolNameMap = new Map<string, string>();

  try {
    if (isAuto) {
      const chain = await buildAutoChain(backend);
      if (chain.length === 0) {
        return openAIErrorResponse(404, "No models available on any configured account.", "invalid_request_error", "model_not_found");
      }
      const autoHandle = await orchestrateAutoGenerate({
        chain,
        backend,
        signal: req.signal,
        buildBody: async (candidate) => {
          const translated = await translateOpenAIToGemini(parsed, candidate);
          toolNameMap = translated.toolNameMap;
          return translated.body;
        },
      });
      handle = autoHandle;
      modelUsed = autoHandle.modelUsed;
    } else {
      const translated = await translateOpenAIToGemini(parsed, model);
      toolNameMap = translated.toolNameMap;
      handle = await orchestrateGenerate({ model, backend, body: translated.body, signal: req.signal });
    }
  } catch (err) {
    if (err instanceof TranslationError) return openAIErrorResponse(400, err.message);
    if (err instanceof NoAccountAvailableError) {
      return new Response(JSON.stringify({ error: { message: err.message, type: "insufficient_quota" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(Math.ceil(err.retryAfterMs / 1000)) },
      });
    }
    if (err instanceof TransportError) {
      const status = err.kind === "bad_request" ? 400 : 502;
      return openAIErrorResponse(status, err.body ? `${err.message}: ${err.body}` : err.message, "upstream_error");
    }
    return openAIErrorResponse(502, err instanceof Error ? err.message : "Upstream request failed", "upstream_error");
  }

  // Echoes the client's requested id normally, but for `auto` reports which
  // real model actually answered — otherwise the caller has no way to know.
  const responseModelId = isAuto ? modelUsed : parsed.model;
  const streaming = parsed.stream === true;
  // Surfaces which backend/account actually served the request — mirrors
  // responseModelId's "otherwise the caller has no way to know" for `auto`,
  // but is useful for pinned-model requests too since a model id alone
  // doesn't say whether it came from an OAuth account or an API key.
  const servedVia = `${handle.accountUsed.backend}:${accountIdentity(handle.accountUsed)}`;

  if (!streaming) {
    try {
      const result = await aggregateGeminiToOpenAI(handle.events, responseModelId, toolNameMap);
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json", "x-served-via": servedVia },
      });
    } catch (err) {
      return openAIErrorResponse(502, err instanceof Error ? err.message : "Upstream stream failed mid-response", "upstream_error");
    }
  }

  const includeUsage = !!parsed.stream_options?.include_usage;
  const translator = createOpenAIStreamTranslator(responseModelId, toolNameMap, includeUsage);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const gemini of handle.events) {
          for (const line of translator.feed(gemini)) controller.enqueue(encoder.encode(line + "\n\n"));
        }
        for (const line of translator.finalizeLines()) controller.enqueue(encoder.encode(line + "\n\n"));
      } catch (err) {
        // Mid-stream failure. orchestrate.ts already committed to this
        // account (first event was already delivered), so we must NOT retry
        // here — that would duplicate content or re-issue tool calls under
        // new ids. But that's no reason to hide the failure either: closing
        // the stream via the normal finalizeLines() path (as this used to do
        // once any content had been emitted) synthesizes a clean "stop"/
        // "tool_calls" finish chunk indistinguishable from a real
        // completion — the caller has no way to tell a truncated response
        // from a deliberately short one. Always surface the error instead,
        // even after content has streamed.
        const message = err instanceof Error ? err.message : String(err);
        for (const line of translator.finalizeWithError(message)) controller.enqueue(encoder.encode(line + "\n\n"));
      } finally {
        controller.close();
      }
    },
    cancel() {
      // Client disconnected — nothing to clean up beyond letting the abort
      // signal (already wired into the upstream fetch) propagate.
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-served-via": servedVia,
    },
  });
}

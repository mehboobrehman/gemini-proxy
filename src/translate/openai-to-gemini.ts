import { sanitizeResponseSchema, sanitizeToolParameters } from "./schema";
import type {
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiGenerationConfig,
  GeminiPart,
  GeminiRequestBody,
  GeminiTool,
  OpenAIChatRequest,
  OpenAIContentBlock,
  OpenAIMessage,
  OpenAITool,
  OpenAIToolChoice,
} from "../types";

export interface TranslatedRequest {
  body: GeminiRequestBody;
  /** sanitized Gemini function name -> original OpenAI tool name */
  toolNameMap: Map<string, string>;
  allowParallelToolCalls: boolean;
}

export class TranslationError extends Error {}

function extractText(content: OpenAIMessage["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

function sanitizeToolName(name: string): string {
  let out = name.replace(/[^a-zA-Z0-9_.\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(out)) out = "_" + out;
  return out.slice(0, 64);
}

/** Reverses encodeToolCallId (gemini-to-openai.ts) — recovers the thoughtSignature Gemini 3 requires back on replay. */
function decodeToolCallId(id: string): { rawId: string; thoughtSignature?: string } {
  const idx = id.indexOf("~");
  if (idx === -1) return { rawId: id };
  try {
    return { rawId: id.slice(0, idx), thoughtSignature: Buffer.from(id.slice(idx + 1), "base64url").toString("utf-8") };
  } catch {
    return { rawId: id };
  }
}

async function resolveImageBlock(block: OpenAIContentBlock): Promise<GeminiPart | null> {
  const url = block.image_url?.url;
  if (!url) return null;
  if (url.startsWith("data:")) {
    const commaIdx = url.indexOf(",");
    if (commaIdx === -1) return null;
    const header = url.slice(5, commaIdx);
    const data = url.slice(commaIdx + 1);
    const mimeType = header.replace(";base64", "") || "image/png";
    return { inlineData: { mimeType, data } };
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/png";
      return { inlineData: { mimeType, data: Buffer.from(buf).toString("base64") } };
    } catch {
      return null;
    }
  }
  return null;
}

async function messageToParts(m: OpenAIMessage, isClaudeModel: boolean): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = [];

  if (m.tool_calls && m.tool_calls.length > 0) {
    const text = extractText(m.content);
    if (text) parts.push({ text });
    for (const tc of m.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
      } catch {
        // malformed arguments from the client — send an empty call rather than failing the whole turn
      }
      const { rawId, thoughtSignature } = decodeToolCallId(tc.id);
      const fc: NonNullable<GeminiPart["functionCall"]> = { name: sanitizeToolName(tc.function.name), args };
      if (isClaudeModel) fc.id = rawId;
      const part: GeminiPart = { functionCall: fc };
      if (thoughtSignature) part.thoughtSignature = thoughtSignature;
      parts.push(part);
    }
    return parts;
  }

  if (typeof m.content === "string") {
    if (m.content) parts.push({ text: m.content });
    return parts;
  }

  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (block.type === "text") {
        if (block.text) parts.push({ text: block.text });
      } else if (block.type === "image_url") {
        const part = await resolveImageBlock(block);
        if (part) parts.push(part);
      }
    }
  }

  return parts;
}

function toFunctionResponsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { output: parsed };
  } catch {
    return { output: raw };
  }
}

/**
 * Gemini requires the number of functionResponse parts in a turn to equal
 * the number of functionCall parts in the immediately preceding model turn,
 * in the same order — otherwise the whole request 400s. Well-behaved OpenAI
 * clients always answer every call before continuing, so this is a
 * defensive fallback for incomplete histories, not the common path.
 */
function padMissingFunctionResponses(contents: GeminiContent[], isClaudeModel: boolean): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (let i = 0; i < contents.length; i++) {
    const current = contents[i]!;
    out.push(current);
    if (current.role !== "model") continue;

    const calls = current.parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
    if (calls.length === 0) continue;

    const next = contents[i + 1];
    const existingResponses = next && next.role === "user" ? next.parts.filter((p) => p.functionResponse) : [];
    if (existingResponses.length >= calls.length) continue;

    const missing = calls.slice(existingResponses.length).map((call): GeminiPart => {
      const part: GeminiPart = { functionResponse: { name: call.name, response: { error: "no response provided" } } };
      if (isClaudeModel && call.id) part.functionResponse!.id = call.id;
      return part;
    });

    if (next && next.role === "user") {
      next.parts.push(...missing);
    } else {
      out.push({ role: "user", parts: missing });
    }
  }
  return out;
}

async function convertMessages(
  messages: OpenAIMessage[],
  isClaudeModel: boolean,
): Promise<{ contents: GeminiContent[]; systemParts: GeminiPart[] }> {
  const contents: GeminiContent[] = [];
  const systemParts: GeminiPart[] = [];

  const idToName = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) idToName.set(tc.id, tc.function.name);
    }
  }

  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      const text = extractText(m.content);
      if (text) systemParts.push({ text });
      continue;
    }

    if (m.role === "tool") {
      const originalName = (m.tool_call_id && idToName.get(m.tool_call_id)) || m.name || "tool";
      const name = sanitizeToolName(originalName);
      const part: GeminiPart = {
        functionResponse: { name, response: toFunctionResponsePayload(extractText(m.content)) },
      };
      if (isClaudeModel && m.tool_call_id) part.functionResponse!.id = decodeToolCallId(m.tool_call_id).rawId;

      const last = contents[contents.length - 1];
      if (last && last.role === "user") last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      continue;
    }

    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    const parts = await messageToParts(m, isClaudeModel);
    if (parts.length === 0) continue;

    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }

  return { contents: padMissingFunctionResponses(contents, isClaudeModel), systemParts };
}

function convertTools(tools: OpenAITool[]): { geminiTools: GeminiTool[]; toolNameMap: Map<string, string> } {
  const toolNameMap = new Map<string, string>();
  const used = new Set<string>();
  const decls: GeminiFunctionDeclaration[] = [];

  for (const t of tools) {
    if (t.type !== "function") continue;
    let sanitized = sanitizeToolName(t.function.name);
    while (used.has(sanitized)) sanitized = `${sanitized.slice(0, 58)}_${Math.floor(Math.random() * 90 + 10)}`;
    used.add(sanitized);
    toolNameMap.set(sanitized, t.function.name);

    const decl: GeminiFunctionDeclaration = { name: sanitized, description: t.function.description ?? "" };
    const params = sanitizeToolParameters(t.function.parameters);
    if (params) decl.parameters = params;
    decls.push(decl);
  }

  return { geminiTools: decls.length > 0 ? [{ functionDeclarations: decls }] : [], toolNameMap };
}

function convertToolChoice(
  choice: OpenAIToolChoice | undefined,
): GeminiRequestBody["toolConfig"] | undefined {
  if (!choice || choice === "auto") return undefined;
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (typeof choice === "object" && choice.type === "function") {
    return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [sanitizeToolName(choice.function.name)] } };
  }
  return undefined;
}

// The proxy is for your own account's own use, so default to no content
// filtering rather than surprise `content_filter` finishes on legitimate
// requests. "OFF" fully disables the filter (more permissive than
// BLOCK_NONE, which still evaluates but never blocks). Only these four
// categories are used — verified live against both the Antigravity and
// Claude-via-Antigravity backends; HARM_CATEGORY_CIVIC_INTEGRITY, despite
// being a recognized enum value, was rejected as invalid for these models
// when tested, so it's deliberately left out rather than guessed at.
export const SAFETY_SETTINGS: Array<{ category: string; threshold: string }> = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
];

function buildGenerationConfig(req: OpenAIChatRequest, hasTools: boolean): GeminiGenerationConfig | undefined {
  const gc: GeminiGenerationConfig = {};
  if (req.temperature !== undefined) gc.temperature = req.temperature;
  if (req.top_p !== undefined) gc.topP = req.top_p;

  const maxTokens = req.max_tokens ?? req.max_completion_tokens;
  if (maxTokens !== undefined) gc.maxOutputTokens = maxTokens;

  if (req.stop !== undefined) {
    const stops = Array.isArray(req.stop) ? req.stop : [req.stop];
    gc.stopSequences = stops.slice(0, 5);
  }

  if (req.response_format?.type === "json_object") {
    gc.responseMimeType = "application/json";
  } else if (req.response_format?.type === "json_schema" && !hasTools) {
    // responseSchema + tools together is rejected upstream — tools win when both are present.
    gc.responseMimeType = "application/json";
    const schema = sanitizeResponseSchema(req.response_format.json_schema?.schema);
    if (schema) gc.responseSchema = schema;
  }

  if (req.reasoning_effort) {
    const budget = req.reasoning_effort === "high" ? 24576 : req.reasoning_effort === "low" ? 1024 : 8192;
    gc.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
  }

  return Object.keys(gc).length > 0 ? gc : undefined;
}

export async function translateOpenAIToGemini(req: OpenAIChatRequest, resolvedModel: string): Promise<TranslatedRequest> {
  if (req.n !== undefined && req.n > 1) {
    throw new TranslationError("This proxy does not support n > 1 (Gemini's candidateCount is not reliably supported on the OAuth backend).");
  }

  const isClaudeModel = resolvedModel.toLowerCase().includes("claude");
  const { contents, systemParts } = await convertMessages(req.messages, isClaudeModel);
  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "" }] });

  const { geminiTools, toolNameMap } = req.tools && req.tools.length > 0 ? convertTools(req.tools) : { geminiTools: [], toolNameMap: new Map<string, string>() };

  const body: GeminiRequestBody = { contents, safetySettings: SAFETY_SETTINGS };
  if (systemParts.length > 0) body.systemInstruction = { role: "user", parts: systemParts };
  if (geminiTools.length > 0) body.tools = geminiTools;

  const toolConfig = convertToolChoice(req.tool_choice);
  if (toolConfig) body.toolConfig = toolConfig;

  const generationConfig = buildGenerationConfig(req, geminiTools.length > 0);
  if (generationConfig) body.generationConfig = generationConfig;

  return {
    body,
    toolNameMap,
    allowParallelToolCalls: req.parallel_tool_calls !== false,
  };
}

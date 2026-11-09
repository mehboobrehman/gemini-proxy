// ---------------------------------------------------------------------------
// OpenAI wire types (subset actually used by this proxy)
// ---------------------------------------------------------------------------

export interface OpenAIContentBlock {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentBlock[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIFunctionDef;
}

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: { type: string; json_schema?: { schema?: Record<string, unknown> } };
  reasoning_effort?: "low" | "medium" | "high";
  n?: number;
}

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface OpenAIDelta {
  role?: "assistant";
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCallDelta[];
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
}

// ---------------------------------------------------------------------------
// Gemini native types (subset — the shape we send/receive on v1internal and
// v1beta, which are otherwise identical for our purposes)
// ---------------------------------------------------------------------------

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean };
}

export interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { role?: "user"; parts: GeminiPart[] };
  tools?: GeminiTool[];
  toolConfig?: {
    functionCallingConfig: { mode: "AUTO" | "NONE" | "ANY"; allowedFunctionNames?: string[] };
  };
  generationConfig?: GeminiGenerationConfig;
  safetySettings?: Array<{ category: string; threshold: string }>;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  responseId?: string;
}

// ---------------------------------------------------------------------------
// Accounts / persisted state
// ---------------------------------------------------------------------------

export type Backend = "antigravity" | "apikey";

export interface AccountBase {
  id: string;
  backend: Backend;
  label?: string;
  addedAt: number;
  lastUsed: number;
  disabled?: boolean;
  disabledReason?: string;
}

export interface OAuthAccount extends AccountBase {
  backend: "antigravity";
  email?: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  projectId?: string;
  endpointBase?: string;
}

export interface ApiKeyAccount extends AccountBase {
  backend: "apikey";
  apiKey: string;
}

export type Account = OAuthAccount | ApiKeyAccount;

export interface Cooldown {
  until: number;
  reason: string;
}

export interface StoreState {
  version: 1;
  accounts: Account[];
  /** key: `${accountId}::${model}` */
  cooldowns: Record<string, Cooldown>;
}

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  backend: Backend;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
}

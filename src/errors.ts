export type TransportErrorKind =
  | "rate_limit"
  | "quota_exhausted"
  | "auth"
  | "invalid_key"
  | "permission"
  | "server"
  | "bad_request"
  | "not_found"
  | "unknown";

export class TransportError extends Error {
  kind: TransportErrorKind;
  status: number;
  retryAfterMs?: number;
  body?: string;

  constructor(
    kind: TransportErrorKind,
    status: number,
    message: string,
    opts?: { retryAfterMs?: number; body?: string },
  ) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = opts?.retryAfterMs;
    this.body = opts?.body;
  }
}

/** All accounts exhausted / cooling down — no transport attempt was even possible. */
export class NoAccountAvailableError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`No account available for this model. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = "NoAccountAvailableError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function openAIErrorBody(message: string, type: string, code?: string) {
  return { error: { message, type, code: code ?? null } };
}

export function openAIErrorResponse(status: number, message: string, type = "invalid_request_error", code?: string): Response {
  return new Response(JSON.stringify(openAIErrorBody(message, type, code)), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Parses `RetryInfo`/plain-seconds retry hints out of a Google error body. Returns ms, or undefined. */
export function parseRetryDelayMs(body: string | undefined): number | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { details?: Array<{ "@type"?: string; retryDelay?: string }> };
    };
    const detail = parsed.error?.details?.find(
      (d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
    );
    const raw = detail?.retryDelay;
    if (!raw) return undefined;
    const match = /^([\d.]+)s$/.exec(raw);
    if (!match || !match[1]) return undefined;
    const seconds = parseFloat(match[1]);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
  } catch {
    return undefined;
  }
}

export function classifyHttpError(status: number, body: string): TransportError {
  if (status === 429) {
    const retryAfterMs = parseRetryDelayMs(body) ?? 60_000;
    const reasonKind = classifyResourceExhausted(body);
    const kind: TransportErrorKind = reasonKind === "quota_exhausted" ? "quota_exhausted" : "rate_limit";
    return new TransportError(kind, status, "Rate limited", { retryAfterMs, body });
  }
  if (status === 401) return new TransportError("auth", status, "Unauthorized", { body });
  if (status === 403) return new TransportError("permission", status, "Forbidden", { body });
  if (status === 404) return new TransportError("not_found", status, "Model or endpoint not found", { body });
  if (status >= 500) return new TransportError("server", status, "Upstream server error", { body });
  // A bad API key surfaces as a plain 400 (INVALID_ARGUMENT/API_KEY_INVALID),
  // not 401 — but it's an account-credential problem, not a malformed-request
  // one, so it needs to disable-and-rotate like auth/permission do rather
  // than fall into the generic "bad_request" bucket below, which
  // deliberately never rotates (see orchestrate.ts) since retrying a
  // genuinely malformed request on a different account would fail
  // identically. Misclassifying this meant one bad key could permanently
  // stick as the sticky pick for a model and never get rotated away from.
  if (status === 400 && isInvalidApiKey(body)) {
    return new TransportError("invalid_key", status, "Invalid API key", { body });
  }
  if (status >= 400) return new TransportError("bad_request", status, "Bad request", { body });
  return new TransportError("unknown", status, `Unexpected status ${status}`, { body });
}

/**
 * Human-readable disable reason for the error kinds that take an account out
 * of rotation entirely (as opposed to a cooldown). Shared by the live
 * request-failure path (orchestrate.ts) and the standalone key-validation
 * check (transports/apikey.ts's validateApiKey), so an account disabled by
 * either route shows identical wording.
 */
export function disabledReasonFor(err: TransportError): string | null {
  switch (err.kind) {
    case "auth":
      return "Authentication failed (401) — check/re-add this account.";
    case "invalid_key":
      return "API key invalid or revoked (400) — remove this account and re-add a corrected key.";
    case "permission":
      return "Permission denied (403).";
    default:
      return null;
  }
}

/** Detects Google's `API_KEY_INVALID` ErrorInfo reason inside a 400 body. */
function isInvalidApiKey(body: string | undefined): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: string; details?: Array<{ "@type"?: string; reason?: string }> };
    };
    if (parsed.error?.status !== "INVALID_ARGUMENT") return false;
    const info = parsed.error.details?.find(
      (d) => d["@type"] === "type.googleapis.com/google.rpc.ErrorInfo",
    );
    return info?.reason?.toUpperCase() === "API_KEY_INVALID";
  } catch {
    return false;
  }
}

/** RESOURCE_EXHAUSTED reason classification, following the pattern CLIProxyAPI uses. */
export function classifyResourceExhausted(body: string | undefined): "quota_exhausted" | "rate_limited" | "unknown" {
  if (!body) return "unknown";
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: string; details?: Array<{ "@type"?: string; reason?: string }> };
    };
    if (parsed.error?.status !== "RESOURCE_EXHAUSTED") return "unknown";
    const info = parsed.error.details?.find(
      (d) => d["@type"] === "type.googleapis.com/google.rpc.ErrorInfo",
    );
    const reason = info?.reason?.toUpperCase();
    if (reason === "QUOTA_EXHAUSTED") return "quota_exhausted";
    if (reason === "RATE_LIMIT_EXCEEDED") return "rate_limited";
    const lower = body.toLowerCase();
    if (lower.includes("quota") && lower.includes("exhaust")) return "quota_exhausted";
    return "unknown";
  } catch {
    return "unknown";
  }
}

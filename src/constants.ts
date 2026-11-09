// Antigravity OAuth + Cloud Code Assist ("v1internal") constants.
//
// Verified live 2026-07 by cross-referencing the actively maintained
// router-for-me/CLIProxyAPI (44k★, pushed same day) against the archived
// (2025-12-15) theblazehen/opencode-antigravity-multi-auth — the client
// credentials are byte-identical between the two, confirming they are still
// valid, but CLIProxyAPI's endpoints (no ".sandbox") are what we follow since
// it is current. Also confirmed directly via a live OAuth + generateContent
// round trip during development of this project.
export const ANTIGRAVITY_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_CLIENT_SECRET = "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";

export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";

export const ANTIGRAVITY_OAUTH_CALLBACK_PORT = 51121;
export const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_OAUTH_CALLBACK_PORT}/oauth-callback`;

// Endpoint fallback order: prod first (most reliable for project discovery
// per the archived reference repo's own comments), then the "daily" channel.
export const ANTIGRAVITY_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.googleapis.com",
];

// Verified 2026-07-25 via a real mitmproxy capture of Antigravity 2.3.1's
// own traffic: "antigravity/hub/2.3.1 (aidev_client; os_type=windows;
// arch=amd64)". The platform segment is computed per-host below rather than
// hardcoded, since the captured string was Windows-specific and this proxy
// may run elsewhere.
const ANTIGRAVITY_CLIENT_VERSION = "2.3.1";

function antigravityOsType(): string {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    default:
      return "linux";
  }
}

function antigravityArch(): string {
  return process.arch === "x64" ? "amd64" : process.arch;
}

export const ANTIGRAVITY_USER_AGENT = `antigravity/hub/${ANTIGRAVITY_CLIENT_VERSION} (aidev_client; os_type=${antigravityOsType()}; arch=${antigravityArch()})`;

// Requests to the AI Studio public API use this base; the OpenAI-compatible
// layer exists too (v1beta/openai/) but we normalize everything to Gemini's
// own generateContent shape instead so both backends share one translator.
export const AI_STUDIO_BASE = "https://generativelanguage.googleapis.com";

export const DEFAULT_PORT = 8765;
export const DEFAULT_HOST = "127.0.0.1";

// FALLBACK ONLY. Live model discovery (oauth.ts fetchAvailableModels, wired
// up in models.ts) is the real source of truth — it hits Antigravity's own
// v1internal:fetchAvailableModels endpoint, which is what the actual
// Antigravity client uses, so it reflects Google's lineup in real time
// instead of going stale (this list itself went stale once already: Claude
// moved from the 4.5 line to 4.6, and several Gemini 3.x ids were renamed,
// all within the same day this file was first written). This snapshot is
// only used if every account's live fetch fails (offline, endpoint down).
export const ANTIGRAVITY_MODELS = [
  "gemini-pro-agent",
  "gemini-3-flash",
  "gemini-3-flash-agent",
  "gemini-3.1-pro-low",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-image",
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-extra-low",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

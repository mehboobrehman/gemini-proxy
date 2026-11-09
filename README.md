# gemini-proxy

A local, OpenAI-compatible HTTP proxy for Google Gemini with **multi-account
auto-rotation**. Point any OpenAI SDK or tool at it — no API key required.

```
Base URL: http://127.0.0.1:8765/v1
```

## Two ways to add accounts

1. **Google OAuth (Antigravity)** — sign in with a personal Google account
   through the browser, no billing setup. Uses the same free-tier mechanism as
   Google's Antigravity IDE. **Read the warning below before using this.**
2. **AI Studio API key** — the official, ToS-safe path. Get a key at
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

Add as many of either kind as you want. The proxy picks one account per
`(backend, model)` pair and sticks with it until that account hits a rate
limit or quota error, then automatically rotates to the next available one.
State (accounts, cooldowns) persists across restarts.

You can add the *same* Google account both ways — an OAuth login and an API
key are different credential types with independent quota pools even for
the same underlying account, so this isn't redundant, it's two real buckets
of capacity that rotate between each other like any other two accounts.
Re-adding the same OAuth email replaces its stored credentials in place
rather than creating a duplicate row; re-adding the exact same API key is
rejected outright, since unlike OAuth there's nothing to refresh — it'd
just be an accidental duplicate.

API keys are checked with a real (trivial, ~1-token) generation request the
moment you add them — a bad or restricted key shows up disabled with a
reason right away instead of silently sitting as "active" until it happens
to be picked by real traffic. Click **test** next to any API key account in
the web UI to re-check it on demand at any time (e.g. after fixing a key
elsewhere) — it disables or re-enables the account based on the result.

Click **disable** next to any account to take it out of rotation on demand —
disabled accounts are skipped by selection entirely (same mechanism as an
auto-disabled account) until you click **re-enable**. A manually disabled
account shows a neutral "disabled" badge rather than the red "needs
attention" one, which is reserved for a genuine account-level error (bad
key, rejected refresh token).

> **Warning:** OAuth accounts use Google's internal, undocumented Antigravity
> Code Assist API. This is very likely a Terms of Service violation and could
> get the Google account suspended or rate-limited without notice. **Use a
> throwaway account, not your primary one.** AI Studio API keys carry no such
> risk.

## Installation

```bash
bun install
```

## Running

**Windows:** double-click `run.bat`. It installs dependencies on first run,
starts the server in a visible console window, and opens
`http://127.0.0.1:8765/` in your default browser automatically once it's
ready.

Prefer no window at all? Double-click `run-background.vbs` instead — same
thing, but fully detached and hidden; nothing appears on screen, not even a
brief flash (a `.bat` always gets an instant console flash from Explorer no
matter how fast it exits, so this is a `.vbs` rather than a `.bat` — a
script run through `wscript.exe` never attaches a console at all). Since
there's no console to show output, logs go to
`%LOCALAPPDATA%\gemini-proxy\background.log` (server output) and
`launcher.log` (startup/guard messages) instead.

On a work machine with restricted user rights, `run.bat`/`run.ps1` and
`run-background.vbs` may not work — PowerShell script execution and Windows
Script Host are both common Group Policy lockdown targets. If
`bun run src/server.ts` still works when you type it directly, use
`run-restricted.bat` (minimized console window, needs only `cmd.exe`) or
`run-restricted.vbs` (fully hidden, needs only WSH — worth trying even if
`run-background.vbs` doesn't work, since PowerShell and WSH are gated by
separate policy settings) instead. Whichever works for you also determines
which one to auto-start at login (see below).

Whichever of the four you used, double-click `stop.bat` to stop it — it
finds whatever process is actually listening on the proxy's port and stops
just that one, so it works regardless of how it was started, and is safe to
run from a different window than the one that started it. (`stop.bat` itself
needs PowerShell script execution; if that's restricted for you, stop it
manually instead: `netstat -ano | findstr :8765` to find the PID, then
`taskkill /PID <pid> /F`.) Only one instance is ever allowed to run at a
time — starting any of the four while the proxy is already running stops
the existing instance first, then starts a fresh one, rather than running
two at once. That also means starting any of the four is a safe way to
restart the proxy, whichever of the four (or a plain
`bun run src/server.ts`) started the one currently running.

You can also auto-start it at login: create a shortcut to whichever script
worked for you above and drop it in `shell:startup`. For `run-restricted.bat`
specifically, also set the shortcut's **Run** property to **Minimized**
(right-click the shortcut → Properties) — the other three are already
silent/hidden on their own.

**Any platform:**

```bash
bun run src/server.ts
```

## Quick start

Open `http://127.0.0.1:8765/` and click **Add Google account** or **Add AI
Studio API key**. Or use the CLI:

```bash
bun run cli login              # OAuth — opens a browser
bun run cli add-key AIza...    # API key
bun run cli list
bun run cli remove <id-prefix>
```

Then point any OpenAI-compatible client at the proxy:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8765/v1", api_key="unused")
resp = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

```ts
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:8765/v1", apiKey: "unused" });
```

Streaming (`stream: true`) and tool/function calling (including parallel
tool calls) both work, on both backends.

## Image generation

Image-capable models (e.g. `gemini-3.1-flash-image`, discovered live like any
other model) work through normal `/v1/chat/completions` — just send a regular
message. The generated image comes back as a `message.images` array (`delta.images`
when streaming), matching the same convention OpenAI itself uses for chat-based
image generation (gpt-image-in-chat, Nano Banana, etc):

```json
"message": {
  "role": "assistant",
  "content": null,
  "images": [{ "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }]
}
```

For clients that only ever speak the OpenAI **Images API** rather than chat
completions (e.g. the Vercel AI SDK's `@ai-sdk/openai-compatible` image
model, which some apps use exclusively and never fall back to chat), there's
also `POST /v1/images/generations`:

```bash
curl -X POST http://127.0.0.1:8765/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.1-flash-image","prompt":"A red circle on a white background"}'
```

Returns the standard `{"created": ..., "data": [{"b64_json": "..."}]}` shape.
`n` (up to 4) fires that many parallel generations. `response_format` and
`size` are accepted but ignored — this always returns `b64_json` regardless
of what's requested, since the proxy has no public file host to hand back a
real `url`, and `b64_json` is what every client actually needs the bytes
for anyway. Under the hood this reuses the same multi-account rotation as
chat completions.

## Content filtering

All four Gemini safety categories (harassment, hate speech, sexually
explicit, dangerous content) are sent with `threshold: "OFF"` by default —
this is your own account being used through your own proxy, so the proxy
doesn't second-guess it with spurious `content_filter` finishes. To restore
Google's default filtering, edit `SAFETY_SETTINGS` in
`src/translate/openai-to-gemini.ts`.

## Model ids

`GET /v1/models` returns the union of what's available across your accounts.
If you have accounts on both backends and the same model name exists on
both, the proxy picks whichever backend has an eligible account — or pin one
explicitly:

- `antigravity/gemini-3-pro-high`
- `aistudio/gemini-2.5-flash`

Antigravity's model list is discovered **live** from each account (Google
renumbers it often — Claude alone moved from the 4.5 line to 4.6 within a
day of this project being written), including non-Gemini models tunneled
through the same backend (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`,
`gpt-oss-120b-medium`, and others). Results are cached for 5 minutes per
account. `src/constants.ts`'s `ANTIGRAVITY_MODELS` is only a fallback for
when live discovery fails on every account (offline, endpoint down) — it's
not the primary source and doesn't need to be kept up to date by hand.

Click **quota** next to an Antigravity account in the web UI to see
Google's own remaining-quota fraction and reset time for every model on
that account (lowest remaining first) — the same data the `fetchAvailableModels`
discovery call above returns, just surfaced per account instead of merged.
Not available for AI Studio API key accounts, since Google has no equivalent
per-key quota endpoint — **test** (see above) is the closest equivalent
there. Click an API key account's identity in the table to copy its full
key to the clipboard — fetched fresh on click, not something that otherwise
sits in the page (the regular account list the UI polls only ever contains
the masked form).

## How rotation works

- **Sticky selection**: the same account is reused for a given
  `(backend, model)` until it fails.
- **OAuth preferred over API keys**: for an unprefixed model id (eligible on
  both backends), Antigravity OAuth accounts are tried before AI Studio API
  keys — an API key is only picked once every eligible OAuth account for
  that model is cooling down or disabled. If a request is currently stuck on
  an API-key account as a fallback and an OAuth account frees back up, the
  next request switches back to OAuth rather than continuing to spend the
  much scarcer API-key quota. Pinning a backend explicitly
  (`antigravity/...` / `aistudio/...`) bypasses this, since there's only one
  backend to choose from anyway.
- **Commit-on-first-content**: the proxy waits for the first real byte of a
  response before committing to an account, so 429/401/5xx failures (which
  arrive before any content) are retried on another account transparently —
  the client never sees them. Once content has started streaming to the
  client, the proxy never retries or switches, since replaying would
  duplicate text or re-issue tool calls under new ids.
- **Cooldowns** are per `(account, model)`, not per account — a rate limit
  on one model doesn't take an account out of rotation for other models.
- If every eligible account is cooling down, you get a `429` with a
  `Retry-After` header telling you when the soonest one frees up.

Check current account/cooldown status at `GET /admin/accounts` or in the
web UI.

## `auto` model selection

Request `model: "auto"` (it shows up in `GET /v1/models`, owned by
`gemini-proxy`) instead of a specific model id to let the proxy pick one for
you, in this order:

1. **Pro** — newest generation first, then tier (`high` > `medium`/plain/
   `preview` > `low` > `extra-low`).
2. **Claude** — `claude-opus-*` before `claude-sonnet-*`, as a
   capability-equivalent fallback once every Pro variant is exhausted.
3. **Flash** — same newest-generation-then-tier rule as Pro.
4. **Flash-Lite** — same rule again, one notch down.
5. Everything else left over that's still a genuine text chat model (e.g. a
   model from an unfamiliar/third-party family) but doesn't match any of the
   groups above, in no particular order, as a last resort.

Within each Gemini group, a `-latest` id (`gemini-pro-latest`,
`gemini-flash-latest`, `gemini-flash-lite-latest`) leads — Google keeps
those pointed at whatever's currently their best in that family, so they're
usually the only entry that matters in practice. This ranking is computed
fresh from whatever `GET /v1/models` currently returns (see `src/auto.ts`),
not a hardcoded list, since Google reshuffles model ids often enough that a
static list would need constant hand-editing. Models tunneled through
Gemini for a different modality or tool-calling style (image/TTS/
computer-use/robotics/agent-tuned variants) are never `auto` candidates,
since routing a plain chat request to one of those would silently return
something the caller isn't expecting.

`auto` reuses the exact same per-model account rotation as a pinned model
id: for whichever candidate it's currently trying, every account on both
backends is exhausted first (existing sticky/OAuth-preferred/cooldown
rules, unchanged) before the proxy moves down to the next candidate in the
list above. A model-specific rejection (e.g. one particular tier variant
400ing) is treated the same as a quota error for this purpose — it skips
that one candidate rather than failing the whole request. Only once every
candidate is exhausted does the caller see a `429`. The response's `model`
field reports whichever real model actually answered, not `"auto"`, so
callers can tell what ran.

`auto` shares one 120-second wall-clock budget across the *whole* chain
(a pinned model request keeps its own, separate 60-second budget) — a slow
candidate spends down the same shared pool rather than each candidate
getting its own fresh window, so a handful of slow-failing candidates can't
silently compound into minutes, and one bad candidate can't starve every
one after it.

Every upstream connection also has its own 20-second connect timeout
(bounding only the wait for a response to start — never a slow-but-real
stream already in progress, e.g. a long thinking pause), so a stalled
connection can't hang a request indefinitely; previously only the client's
own disconnect could interrupt one.

Antigravity accounts also get their real per-model quota rechecked for
free every 5 minutes (the same discovery call `GET /v1/models` already
uses, not a real generation call) — if Google reports a model has capacity
again, its cooldown is cleared immediately rather than waiting out our own
conservative fallback estimate. AI Studio API keys have no equivalent free
endpoint, so this only applies to Antigravity/OAuth accounts, and only to
quota/rate-limit cooldowns (a "model not found" or "model rejected this
request" cooldown isn't about remaining quota, so fresh quota data has
nothing to say about it). This same background refresh also keeps the
model-catalog cache (the one backing `GET /v1/models` and `auto`'s
candidate list) warm, so a real request essentially never pays for a live
discovery call just because that cache happened to be stale — it reuses
whatever this refresh already fetched a moment earlier.

## Where state lives

Refresh tokens and API keys are stored in
`%LOCALAPPDATA%\gemini-proxy\state.json` on Windows (XDG state dir
elsewhere) — **not** inside this project folder, since this folder is under
OneDrive and credentials shouldn't sync to the cloud.

`%LOCALAPPDATA%\gemini-proxy\requests.log` records one line per **upstream
attempt** (not per client call — a single request can retry across up to 3
accounts, and `/v1/images/generations` fans out up to `n` in parallel), with
the model, backend, account, and outcome. Useful for answering "why did my
accounts cool down so fast" after the fact instead of guessing.

## Security

The proxy binds to `127.0.0.1` only and requires no API key by design (for
convenience on your own machine). Because of that, it validates the `Host`
header on every request and rejects cross-origin `Origin` headers on
account-management endpoints, to prevent a malicious web page you visit from
using the proxy or your credentials behind your back. It is **not** meant to
be exposed beyond localhost — don't port-forward it or bind it to `0.0.0.0`
without adding real authentication first.

## Known limitations

- `usageMetadata` from the Antigravity backend may be zero/absent for some
  models — usage-based clients may see inaccurate token counts on those.
- A "cooling down" model on an account isn't necessarily a real problem —
  it just means the proxy's own request for that exact model id 404'd or
  429'd last time and is backing off before retrying it on that account.
  Since the model list itself is now discovered live (see above), a
  persistent 404 on a model that `/v1/models` actually lists is worth
  reporting as a bug rather than assumed to be expected; `GET
  /admin/accounts` shows which model(s) are cooling down and why.
- AI Studio's free tier is quite limited for agentic tool-calling loops
  (as low as 100 requests/day on some models) — the proxy already treats it
  as a fallback behind Antigravity accounts automatically for unprefixed
  models (see "How rotation works" above), not something you need to
  manage yourself.

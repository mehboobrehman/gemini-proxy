import { DEFAULT_PORT, DEFAULT_HOST } from "./constants";
import { initAccounts } from "./accounts";
import { startQuotaRefreshLoop } from "./quota-refresh";
import { handleChatCompletions } from "./routes/chat";
import { handleModels } from "./routes/models";
import { handleImageGenerations } from "./routes/images";
import { handleAdmin } from "./routes/admin";
import { renderUI } from "./ui";
import { openAIErrorResponse } from "./errors";
import { currentStatus } from "./requestlog";

await initAccounts();
startQuotaRefreshLoop();

const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const HOST = process.env.HOST || DEFAULT_HOST;

function isAllowedHost(req: Request): boolean {
  const host = req.headers.get("host") ?? "";
  const hostname = host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost";
}

/** curl / OpenAI SDKs don't send an Origin header at all — only browsers do, and only a browser tab is the actual DNS-rebinding/CSRF threat this guards against. */
function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 255, // Bun's 10s default would truncate a streaming response during a long thinking pause.
  async fetch(req) {
    if (!isAllowedHost(req)) {
      return new Response("Forbidden: this proxy only accepts requests addressed to localhost.", { status: 403 });
    }

    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: currentStatus }), { headers: { "content-type": "application/json" } });
    }

    if (url.pathname === "/" && req.method === "GET") return renderUI();

    if (url.pathname === "/v1/models" && req.method === "GET") return handleModels();

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      return handleChatCompletions(req);
    }

    if (url.pathname === "/v1/images/generations" && req.method === "POST") {
      return handleImageGenerations(req);
    }

    if (url.pathname.startsWith("/admin/")) {
      const isMutation = req.method === "POST" || req.method === "DELETE" || req.method === "PUT";
      if (isMutation && !isAllowedOrigin(req)) {
        return new Response("Forbidden: cross-origin request rejected.", { status: 403 });
      }
      return handleAdmin(req, url);
    }

    return openAIErrorResponse(404, `Unknown route: ${req.method} ${url.pathname}`);
  },
  error(err) {
    console.error("[server] Unhandled error:", err);
    return openAIErrorResponse(500, "Internal server error", "server_error");
  },
});

console.log(`gemini-proxy listening on http://${server.hostname}:${server.port}`);
console.log(`  Admin UI:  http://${server.hostname}:${server.port}/`);
console.log(`  Base URL:  http://${server.hostname}:${server.port}/v1  (no API key required)`);

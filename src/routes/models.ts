import { listAvailableModels } from "../models";
import { AUTO_MODEL_ID } from "../auto";

export async function handleModels(): Promise<Response> {
  const models = await listAvailableModels();
  const now = Math.floor(Date.now() / 1000);
  const data = models.map((m) => ({
    id: m.id,
    object: "model",
    created: now,
    owned_by: m.backend === "antigravity" ? "google-antigravity" : "google",
  }));
  // Synthetic entry, not a real upstream model — see auto.ts. Only advertised
  // once at least one real model exists to fall back through.
  if (data.length > 0) {
    data.unshift({ id: AUTO_MODEL_ID, object: "model", created: now, owned_by: "gemini-proxy" });
  }
  return new Response(JSON.stringify({ object: "list", data }), { headers: { "content-type": "application/json" } });
}

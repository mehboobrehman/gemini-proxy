import { ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_MODELS } from "./constants";
import { listAccounts, isApiKey, isOAuth, getValidAccessToken } from "./accounts";
import { listApiKeyModels } from "./transports/apikey";
import { fetchAvailableModels } from "./oauth";
import type { Backend, ModelInfo } from "./types";

const ANTIGRAVITY_PREFIX = "antigravity/";
const AISTUDIO_PREFIX = "aistudio/";
const MODEL_CACHE_TTL_MS = 5 * 60_000;

let apiKeyModelCache: { models: string[]; expiresAt: number } | null = null;

async function getApiKeyModels(): Promise<string[]> {
  if (apiKeyModelCache && apiKeyModelCache.expiresAt > Date.now()) return apiKeyModelCache.models;
  const keyAccounts = listAccounts().filter(isApiKey).filter((a) => !a.disabled);
  if (keyAccounts.length === 0) return [];
  const lists = await Promise.all(keyAccounts.map((a) => listApiKeyModels(a.apiKey)));
  const merged = [...new Set(lists.flat())].sort();
  apiKeyModelCache = { models: merged, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
  return merged;
}

let antigravityModelCache: { models: string[]; expiresAt: number } | null = null;

/**
 * Lets quota-refresh.ts's periodic background loop warm this cache with
 * data it's already fetching for cooldown reconciliation, instead of this
 * cache only ever being filled reactively (the first real request after a
 * 5-minute expiry would otherwise pay for a live discovery call before it
 * could even start resolving `auto` or listing /v1/models).
 */
export function primeAntigravityModelCache(ids: string[]): void {
  antigravityModelCache = { models: [...ids].sort(), expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
}

/**
 * Live discovery via fetchAvailableModels (see oauth.ts) — Google renumbers
 * this lineup often enough that a static list goes stale within hours, so
 * this is the actual source of truth, not the curated ANTIGRAVITY_MODELS
 * fallback (used only if every account's live fetch fails).
 */
async function getAntigravityModels(): Promise<string[]> {
  if (antigravityModelCache && antigravityModelCache.expiresAt > Date.now()) return antigravityModelCache.models;

  const oauthAccounts = listAccounts().filter(isOAuth).filter((a) => !a.disabled);
  for (const account of oauthAccounts) {
    try {
      const token = await getValidAccessToken(account);
      const endpointBase = account.endpointBase || ANTIGRAVITY_ENDPOINTS[0]!;
      const entries = await fetchAvailableModels(token, account.projectId ?? "", endpointBase);
      if (entries.length > 0) {
        const ids = entries.map((e) => e.id).sort();
        antigravityModelCache = { models: ids, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
        return ids;
      }
    } catch {
      // try the next account before giving up
    }
  }

  // Every account's live fetch failed (offline, endpoint down) — fall back
  // to the static list rather than showing nothing. Not cached: retry live
  // discovery on the next call instead of pinning to a stale fallback.
  return [...ANTIGRAVITY_MODELS].sort();
}

/** Union of models across both backends, for GET /v1/models. Unprefixed ids may collide across backends; that's fine — resolution below picks whichever backend actually has an eligible account. */
export async function listAvailableModels(): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  const hasAntigravity = listAccounts().some((a) => a.backend === "antigravity" && !a.disabled);
  if (hasAntigravity) {
    for (const id of await getAntigravityModels()) out.push({ id, backend: "antigravity" });
  }
  for (const id of await getApiKeyModels()) out.push({ id, backend: "apikey" });
  return out;
}

export interface ResolvedModel {
  /** The bare model id to send upstream. */
  model: string;
  /** Pin to a specific backend, or undefined to let account selection decide. */
  backend?: Backend;
}

/** Strips an explicit `antigravity/` or `aistudio/` prefix if present. */
export function resolveModel(requestedId: string): ResolvedModel {
  if (requestedId.startsWith(ANTIGRAVITY_PREFIX)) {
    return { model: requestedId.slice(ANTIGRAVITY_PREFIX.length), backend: "antigravity" };
  }
  if (requestedId.startsWith(AISTUDIO_PREFIX)) {
    return { model: requestedId.slice(AISTUDIO_PREFIX.length), backend: "apikey" };
  }
  return { model: requestedId };
}

/**
 * Checks a resolved model against the same live-discovered list GET /v1/models
 * returns, before any account/backend is touched. Lets callers reject a model
 * Google will never serve (e.g. "gpt-4o" against Antigravity) with a clean,
 * instant 404 instead of burning a real upstream call and a cooldown entry on
 * something that was never going to work.
 */
export async function isKnownModel(resolved: ResolvedModel): Promise<boolean> {
  const all = await listAvailableModels();
  return all.some((m) => m.id === resolved.model && (!resolved.backend || m.backend === resolved.backend));
}

import { listAccounts, isOAuth, getValidAccessToken, reconcileCooldownsFromQuota } from "./accounts";
import { fetchAvailableModels } from "./oauth";
import { primeAntigravityModelCache } from "./models";
import { ANTIGRAVITY_ENDPOINTS } from "./constants";

const REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * Antigravity-only (AI Studio has no equivalent free per-key quota
 * endpoint — see README "Known limitations"). Periodically re-checks each
 * OAuth account's real per-model quota via the same discovery call
 * models.ts already uses, and clears any cooldown Google has already
 * lifted early (see accounts.ts's reconcileCooldownsFromQuota) instead of
 * always waiting out our own conservative fallback duration. This never
 * touches real generation quota — fetchAvailableModels is a metadata call.
 *
 * Also warms models.ts's model-catalog cache with the first account's
 * results (same precedence getAntigravityModels itself uses — first
 * non-empty response wins) so a real request never pays for a live
 * discovery call just because this cache happened to be cold — we're
 * already fetching the exact same data here anyway.
 */
async function refreshOnce(): Promise<void> {
  const oauthAccounts = listAccounts().filter(isOAuth).filter((a) => !a.disabled);
  let primed = false;
  for (const account of oauthAccounts) {
    try {
      const token = await getValidAccessToken(account);
      const endpointBase = account.endpointBase || ANTIGRAVITY_ENDPOINTS[0]!;
      const entries = await fetchAvailableModels(token, account.projectId ?? "", endpointBase);
      if (!primed && entries.length > 0) {
        primeAntigravityModelCache(entries.map((e) => e.id));
        primed = true;
      }
      await reconcileCooldownsFromQuota(account.id, entries);
    } catch {
      // Best-effort — a failed refresh for one account this cycle just
      // means its cooldowns wait out their normal duration as before.
    }
  }
}

export function startQuotaRefreshLoop(): void {
  refreshOnce().catch(() => {});
  setInterval(() => {
    refreshOnce().catch(() => {});
  }, REFRESH_INTERVAL_MS);
}

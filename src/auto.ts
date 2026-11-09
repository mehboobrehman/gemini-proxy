import { listAvailableModels } from "./models";
import type { Backend } from "./types";

/** Requesting this as the model id lets the proxy pick for itself — see buildAutoChain. */
export const AUTO_MODEL_ID = "auto";

// Models tunneled through Gemini's API for a different output modality or a
// specific tool-calling style than plain chat. Excluded from the auto chain
// entirely (not just deprioritized) — routing a normal chat request to e.g.
// an image-output model would either 400 outright or silently return
// something the caller can't use, so probing them is pure wasted budget even
// as a last resort.
const SPECIALTY_MARKERS = ["image", "tts", "computer-use", "robotics", "customtools", "omni", "agent"];

function isSpecialty(id: string): boolean {
  return SPECIALTY_MARKERS.some((marker) => id.includes(marker));
}

type Family = "pro" | "claude" | "flash" | "lite" | "other";

function familyOf(id: string): Family {
  if (id.includes("claude")) return "claude";
  if (id.includes("lite")) return "lite";
  if (id.includes("pro")) return "pro";
  if (id.includes("flash")) return "flash";
  return "other";
}

/** Higher = newer. A `-latest` id is Google's own rolling pointer to its current best in that family, so it always leads. */
function generationOf(id: string): number {
  if (id.endsWith("-latest")) return Infinity;
  const m = id.match(/gemini-(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : -Infinity;
}

const KNOWN_TIER_SUFFIXES: Array<[string, number]> = [
  ["extra-low", 1],
  ["high", 4],
  ["thinking", 4], // extended-reasoning variant reads as the high-effort tier
  ["low", 2],
  ["medium", 3],
  ["preview", 3], // Google's default "current" id on many families, not a downgrade
];

/** Higher = more capable/preferred within the same family+generation. */
function tierRankOf(id: string): number {
  if (id.endsWith("-latest")) return Infinity;
  for (const [suffix, rank] of KNOWN_TIER_SUFFIXES) {
    if (id.includes(`-${suffix}`)) return rank;
  }
  // No suffix at all beyond family+generation -> plain/default id, same
  // rank as an explicit "medium". A suffix we don't recognize (Google adds
  // these often) is deliberately ranked below every known tier rather than
  // assumed safe, since we don't know what it actually changes.
  const bare = /^gemini-\d+(?:\.\d+)?-(pro|flash)(-lite)?$/.test(id);
  return bare ? 3 : 0;
}

const CLAUDE_FAMILY_ORDER = ["claude-opus", "claude-sonnet", "claude-haiku"];

function claudeRank(id: string): number {
  const idx = CLAUDE_FAMILY_ORDER.findIndex((prefix) => id.includes(prefix));
  return idx === -1 ? CLAUDE_FAMILY_ORDER.length : idx;
}

function byGenerationThenTierDesc(a: string, b: string): number {
  const genDiff = generationOf(b) - generationOf(a);
  if (genDiff !== 0) return genDiff;
  return tierRankOf(b) - tierRankOf(a);
}

/**
 * Pure ranking step, split out from buildAutoChain so it can be exercised
 * against a fixed list (tests, a smoke-test script) without touching live
 * account/network state. Order: Pro (newest generation first, then tier),
 * then Claude (opus before sonnet) as a capability-equivalent fallback, then
 * Flash, then Flash-Lite, then everything left over (real chat models that
 * just don't match a known family keyword). Within each Gemini family a
 * `-latest` id leads, since Google keeps it pointed at whatever's currently
 * their best in that family. Specialty/non-chat models (see SPECIALTY_MARKERS)
 * are dropped entirely, not just deprioritized.
 */
export function rankAutoChain(ids: string[]): string[] {
  const unique = [...new Set(ids)].filter((id) => !isSpecialty(id));
  const buckets: Record<Family, string[]> = { pro: [], claude: [], flash: [], lite: [], other: [] };
  for (const id of unique) buckets[familyOf(id)].push(id);

  return [
    ...[...buckets.pro].sort(byGenerationThenTierDesc),
    ...[...buckets.claude].sort((a, b) => claudeRank(a) - claudeRank(b)),
    ...[...buckets.flash].sort(byGenerationThenTierDesc),
    ...[...buckets.lite].sort(byGenerationThenTierDesc),
    ...buckets.other, // no reliable ranking signal for these — order doesn't matter, they're the bottom of the chain regardless
  ];
}

/**
 * Builds the `auto` fallback order from whatever `/v1/models` currently
 * returns — never a hardcoded model list, since Google reshuffles this
 * catalog often enough that a static chain would need constant hand-editing
 * (see models.ts).
 */
export async function buildAutoChain(backend?: Backend): Promise<string[]> {
  const all = await listAvailableModels();
  return rankAutoChain(all.filter((m) => !backend || m.backend === backend).map((m) => m.id));
}

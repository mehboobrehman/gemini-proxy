import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { getConfigDir } from "./store";
import type { OpenAIUsage } from "./types";

export interface QuotaRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
  errorCount: number;
  rateLimitCount: number;
  lastUsedAt: number;
}

export interface QuotaStoreState {
  version: number;
  overall: QuotaRecord;
  models: Record<string, QuotaRecord>;
  accounts: Record<string, QuotaRecord>;
}

function emptyRecord(): QuotaRecord {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requestCount: 0,
    errorCount: 0,
    rateLimitCount: 0,
    lastUsedAt: 0,
  };
}

function emptyState(): QuotaStoreState {
  return {
    version: 1,
    overall: emptyRecord(),
    models: {},
    accounts: {},
  };
}

let quotaState: QuotaStoreState = emptyState();
let loaded = false;
let writeQueue: Promise<void> = Promise.resolve();

function getQuotaPath(): string {
  return join(getConfigDir(), "quota.json");
}

export async function initQuota(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await fs.readFile(getQuotaPath(), "utf-8");
    const data = JSON.parse(raw) as QuotaStoreState;
    if (data.version === 1 && data.overall && data.models && data.accounts) {
      quotaState = data;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[quotaTracker] Failed to load quota state, starting fresh:", err);
    }
    quotaState = emptyState();
  }
  loaded = true;
}

async function persist(): Promise<void> {
  const path = getQuotaPath();
  const task = writeQueue.then(async () => {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmpPath = join(dirname(path), `quota-${Math.random().toString(36).slice(2)}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify(quotaState, null, 2), "utf-8");
    await fs.rename(tmpPath, path);
  });
  writeQueue = task.catch(() => {});
  return task;
}

export interface RecordUsageOptions {
  model: string;
  accountId?: string;
  usage?: OpenAIUsage;
  isError?: boolean;
  isRateLimit?: boolean;
}

export async function recordUsage(opts: RecordUsageOptions): Promise<void> {
  if (!loaded) await initQuota();

  const now = Date.now();
  const prompt = opts.usage?.prompt_tokens ?? 0;
  const completion = opts.usage?.completion_tokens ?? 0;
  const total = opts.usage?.total_tokens ?? (prompt + completion);

  // Update overall
  quotaState.overall.promptTokens += prompt;
  quotaState.overall.completionTokens += completion;
  quotaState.overall.totalTokens += total;
  quotaState.overall.requestCount += 1;
  quotaState.overall.lastUsedAt = now;
  if (opts.isError) quotaState.overall.errorCount += 1;
  if (opts.isRateLimit) quotaState.overall.rateLimitCount += 1;

  // Update model dimension
  if (opts.model) {
    const mRec = (quotaState.models[opts.model] ??= emptyRecord());
    mRec.promptTokens += prompt;
    mRec.completionTokens += completion;
    mRec.totalTokens += total;
    mRec.requestCount += 1;
    mRec.lastUsedAt = now;
    if (opts.isError) mRec.errorCount += 1;
    if (opts.isRateLimit) mRec.rateLimitCount += 1;
  }

  // Update account dimension
  if (opts.accountId) {
    const aRec = (quotaState.accounts[opts.accountId] ??= emptyRecord());
    aRec.promptTokens += prompt;
    aRec.completionTokens += completion;
    aRec.totalTokens += total;
    aRec.requestCount += 1;
    aRec.lastUsedAt = now;
    if (opts.isError) aRec.errorCount += 1;
    if (opts.isRateLimit) aRec.rateLimitCount += 1;
  }

  await persist();
}

export function getQuotaStats(): QuotaStoreState {
  return JSON.parse(JSON.stringify(quotaState));
}

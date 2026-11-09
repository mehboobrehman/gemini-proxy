import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { StoreState } from "./types";

// IMPORTANT: this project directory lives under OneDrive. Refresh tokens must
// never be written inside it or they'd sync to the cloud. Use the OS's local
// (non-roaming/non-synced) app-data directory instead.
export function getConfigDir(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "gemini-proxy");
  }
  const xdgState = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(xdgState, "gemini-proxy");
}

export function getStorePath(): string {
  return join(getConfigDir(), "state.json");
}

function emptyState(): StoreState {
  return { version: 1, accounts: [], cooldowns: {} };
}

let writeQueue: Promise<void> = Promise.resolve();

export async function loadState(): Promise<StoreState> {
  try {
    const raw = await fs.readFile(getStorePath(), "utf-8");
    const data = JSON.parse(raw) as StoreState;
    if (data.version !== 1 || !Array.isArray(data.accounts)) return emptyState();
    if (!data.cooldowns) data.cooldowns = {};
    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    console.error("[store] Failed to read state, starting fresh:", err);
    return emptyState();
  }
}

/** Serialized, atomic (temp file + rename) write — safe against concurrent callers within this process. */
export async function saveState(state: StoreState): Promise<void> {
  const path = getStorePath();
  const task = writeQueue.then(async () => {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmpPath = join(tmpdir(), `gemini-proxy-state-${randomUUID()}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    await fs.rename(tmpPath, path);
  });
  // Swallow errors in the chain itself so one failed write doesn't wedge the
  // queue for subsequent callers; the error still propagates to this caller.
  writeQueue = task.catch(() => {});
  return task;
}

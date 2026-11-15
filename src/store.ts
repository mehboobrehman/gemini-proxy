import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { StoreState } from "./types";
import { encryptSecret, decryptSecret } from "./secureStorage";

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

    // Decrypt sensitive fields (API keys, refresh tokens, access tokens) transparently
    for (const acc of data.accounts) {
      if (acc.backend === "apikey" && acc.apiKey) {
        try {
          acc.apiKey = await decryptSecret(acc.apiKey);
        } catch {
          // If decryption fails, keep as is (might be plaintext already)
        }
      } else if (acc.backend === "antigravity") {
        if (acc.refreshToken) {
          try {
            acc.refreshToken = await decryptSecret(acc.refreshToken);
          } catch {}
        }
        if (acc.accessToken) {
          try {
            acc.accessToken = await decryptSecret(acc.accessToken);
          } catch {}
        }
      }
    }

    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    console.error("[store] Failed to read state, starting fresh:", err);
    return emptyState();
  }
}

export async function saveState(state: StoreState): Promise<void> {
  const path = getStorePath();
  const task = writeQueue.then(async () => {
    await fs.mkdir(dirname(path), { recursive: true });

    // Clone state to encrypt secrets before saving to disk
    const cloned: StoreState = JSON.parse(JSON.stringify(state));
    for (const acc of cloned.accounts) {
      if (acc.backend === "apikey" && acc.apiKey) {
        acc.apiKey = await encryptSecret(acc.apiKey);
      } else if (acc.backend === "antigravity") {
        if (acc.refreshToken) {
          acc.refreshToken = await encryptSecret(acc.refreshToken);
        }
        if (acc.accessToken) {
          acc.accessToken = await encryptSecret(acc.accessToken);
        }
      }
    }

    const tmpPath = join(tmpdir(), `gemini-proxy-state-${randomUUID()}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify(cloned, null, 2), "utf-8");
    await fs.rename(tmpPath, path);
  });
  writeQueue = task.catch(() => {});
  return task;
}

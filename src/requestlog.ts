import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { getConfigDir } from "./store";

/**
 * One line per upstream attempt (not per client request) — orchestrateGenerate
 * can try every eligible account for a single client call, and /v1/images/generations
 * fans out up to 4 in parallel, so "requests per client call" alone hides how
 * many real calls actually hit Google. This makes that visible after the fact,
 * to answer questions like "why did all my accounts cool down so fast" without
 * having to guess.
 */
export interface RequestLogEntry {
  model: string;
  backend?: string;
  accountId?: string;
  accountEmail?: string;
  outcome: string;
  detail?: string;
}

function getLogPath(): string {
  return join(getConfigDir(), "requests.log");
}

let writeQueue: Promise<void> = Promise.resolve();

export let currentStatus: "ok" | "error" = "ok";

export function logRequest(entry: RequestLogEntry): void {
  if (entry.outcome === "ok") {
    currentStatus = "ok";
  } else {
    currentStatus = "error";
  }
  const ts = new Date().toISOString();
  const who = entry.accountEmail || entry.accountId || "-";
  console.log(
    `[request] ${ts} model=${entry.model} backend=${entry.backend ?? "-"} account=${who} outcome=${entry.outcome}${
      entry.detail ? " " + entry.detail : ""
    }`,
  );

  const line = JSON.stringify({ ts, ...entry }) + "\n";
  const path = getLogPath();
  writeQueue = writeQueue
    .then(async () => {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.appendFile(path, line, "utf-8");
    })
    .catch((err) => {
      console.error("[requestlog] Failed to write log:", err);
    });
}

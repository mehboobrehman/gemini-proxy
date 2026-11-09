// Talks to the running server's admin API rather than the store file
// directly, so the server process stays the single writer of state.json.

const BASE = process.env.GEMINI_PROXY_URL || "http://127.0.0.1:8765";

async function api(path: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${opts?.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function printAccountsTable(accounts: any[], cooldowns: any[]) {
  if (accounts.length === 0) {
    console.log("No accounts configured.");
    return;
  }
  const cdByAccount = new Map<string, any[]>();
  for (const cd of cooldowns) {
    const list = cdByAccount.get(cd.accountId) ?? [];
    list.push(cd);
    cdByAccount.set(cd.accountId, list);
  }
  for (const acc of accounts) {
    const identity = acc.backend === "antigravity" ? acc.email ?? "(pending)" : acc.label ?? acc.apiKeyMasked;
    let status = "active";
    if (acc.disabled) status = `DISABLED: ${acc.disabledReason ?? "unknown reason"}`;
    else if (cdByAccount.has(acc.id)) status = `cooling down (${cdByAccount.get(acc.id)!.length} model(s))`;
    console.log(`${acc.id.slice(0, 8)}  ${acc.backend.padEnd(11)} ${String(identity).padEnd(28)} ${status}`);
  }
}

async function cmdList() {
  const { accounts, cooldowns } = await api("/admin/accounts");
  printAccountsTable(accounts, cooldowns);
}

async function cmdAddKey(key: string | undefined, label: string | undefined) {
  if (!key) {
    console.error("Usage: cli add-key <api-key> [label]");
    process.exit(1);
  }
  const { account } = await api("/admin/accounts/apikey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: key, label }),
  });
  console.log(`Added API key account ${account.id} (${account.apiKeyMasked})`);
}

async function cmdRemove(id: string | undefined) {
  if (!id) {
    console.error("Usage: cli remove <account-id-prefix>");
    process.exit(1);
  }
  const { accounts } = await api("/admin/accounts");
  const match = accounts.find((a: any) => a.id === id || a.id.startsWith(id));
  if (!match) {
    console.error(`No account matching "${id}"`);
    process.exit(1);
  }
  await api(`/admin/accounts/${match.id}`, { method: "DELETE" });
  console.log(`Removed ${match.id}`);
}

async function cmdLogin() {
  const { authUrl, state } = await api("/admin/oauth/start", { method: "POST" });
  console.log("Open this URL in your browser and sign in:\n");
  console.log(authUrl);
  console.log("\nWaiting for sign-in to complete...");

  while (true) {
    await new Promise((r) => setTimeout(r, 1500));
    const status = await api(`/admin/oauth/status/${state}`);
    if (status.status === "pending") continue;
    if (status.status === "done") {
      console.log(`Signed in as ${status.email ?? "(unknown email)"}.`);
      return;
    }
    console.error(`Sign-in failed: ${status.error}`);
    process.exit(1);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "list":
      return cmdList();
    case "add-key":
      return cmdAddKey(rest[0], rest[1]);
    case "remove":
      return cmdRemove(rest[0]);
    case "login":
      return cmdLogin();
    default:
      console.log(
        [
          "Usage:",
          "  bun run cli login                 — add a Google account via OAuth",
          "  bun run cli add-key <key> [label]  — add an AI Studio API key",
          "  bun run cli list                   — list accounts and their status",
          "  bun run cli remove <id-prefix>     — remove an account",
          "",
          `Talks to a running proxy at ${BASE} (override with GEMINI_PROXY_URL). Start the server first with "bun start".`,
        ].join("\n"),
      );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

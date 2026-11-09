const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>gemini-proxy</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    max-width: 1040px;
    margin: 2.5rem auto;
    padding: 0 1.25rem;
    line-height: 1.5;
  }
  h1 { font-size: 1.3rem; margin-bottom: 0.25rem; }
  .sub { opacity: 0.65; font-size: 0.9rem; margin-bottom: 1.5rem; }
  code, .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .baseurl {
    background: rgba(127,127,127,0.12);
    border-radius: 8px;
    padding: 0.7rem 0.9rem;
    font-size: 0.95rem;
    margin-bottom: 1.75rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }
  .baseurl button { flex-shrink: 0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.6rem 0.7rem; border-bottom: 1px solid rgba(127,127,127,0.4); }
  th { opacity: 0.6; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap; border-bottom: 2px solid rgba(127,127,127,0.4); }
  .muted { opacity: 0.4; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; position: relative; white-space: nowrap; }
  .badge.ok { background: #1a7f3722; color: #1a7f37; }
  .badge.bad { background: #cf222e22; color: #cf222e; }
  .badge.cooldown { background: #9a670022; color: #9a6700; }
  .badge.exhausted { background: #bc4c0022; color: #bc4c00; }
  .badge.disabled { background: #6e768122; color: #6e7681; }
  .badge[data-tooltip] { cursor: help; }
  .badge.clickable { cursor: pointer; }
  .badge.clickable:hover { filter: brightness(0.92); }
  .copyable { position: relative; cursor: pointer; border-radius: 4px; transition: background 0.12s ease; }
  .copyable:hover { background: rgba(127,127,127,0.15); }
  .badge[data-tooltip]::after, .copyable[data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute; left: 50%; bottom: calc(100% + 9px); transform: translate(-50%, 2px);
    background: #1c1c1cf0; color: #fff; white-space: pre-line; text-align: left;
    width: max-content; max-width: 260px; padding: 0.5rem 0.7rem; border-radius: 7px;
    font-size: 0.75rem; font-weight: 400; line-height: 1.45; letter-spacing: normal; text-transform: none;
    box-shadow: 0 8px 20px rgba(0,0,0,0.3); opacity: 0; pointer-events: none; z-index: 30;
    transition: opacity 0.12s ease, transform 0.12s ease;
  }
  .badge[data-tooltip]::before, .copyable[data-tooltip]::before {
    content: ''; position: absolute; left: 50%; bottom: calc(100% + 4px); transform: translate(-50%, 2px);
    border: 5px solid transparent; border-top-color: #1c1c1cf0;
    opacity: 0; pointer-events: none; z-index: 30; transition: opacity 0.12s ease, transform 0.12s ease;
  }
  .badge[data-tooltip]:hover::after, .badge[data-tooltip]:hover::before,
  .copyable[data-tooltip]:hover::after, .copyable[data-tooltip]:hover::before {
    opacity: 1; transform: translate(-50%, 0);
  }
  button {
    font: inherit; font-size: 0.85rem; padding: 0.4rem 0.8rem; border-radius: 6px;
    border: 1px solid rgba(127,127,127,0.4); background: transparent; cursor: pointer; color: inherit;
  }
  button:hover { background: rgba(127,127,127,0.12); }
  button.primary { background: #2563eb; border-color: #2563eb; color: white; }
  button.primary:hover { background: #1d4ed8; }
  button.danger { color: #cf222e; border-color: #cf222e55; }
  .row-actions { display: flex; gap: 0.4rem; }
  .add-row { display: flex; gap: 0.6rem; margin: 1rem 0 2rem; flex-wrap: wrap; }
  .empty { opacity: 0.6; font-size: 0.9rem; padding: 1rem 0; }
  .warn {
    border: 1px solid #9a670055;
    background: #9a670011;
    border-radius: 8px;
    padding: 0.8rem 1rem;
    font-size: 0.85rem;
    margin-top: 2rem;
  }
  #apikeyForm { display: none; gap: 0.5rem; margin: 0.5rem 0 1.5rem; }
  #apikeyForm input { font: inherit; padding: 0.4rem 0.6rem; border-radius: 6px; border: 1px solid rgba(127,127,127,0.4); background: transparent; color: inherit; }
  #status { font-size: 0.85rem; opacity: 0.8; margin: 0.5rem 0 1rem; min-height: 1.2em; }
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.45);
    display: none; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal-box {
    background: Canvas; color: CanvasText;
    border: 1px solid rgba(127,127,127,0.3);
    border-radius: 10px; padding: 1.25rem 1.4rem; max-width: 360px; width: 90%;
    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
  }
  .modal-box p { margin: 0 0 1.1rem; font-size: 0.9rem; line-height: 1.45; }
  .modal-box.wide {
    max-width: 640px; max-height: 85vh;
    display: flex; flex-direction: column;
  }
  .modal-box h3 { margin: 0 0 0.9rem; font-size: 1rem; flex-shrink: 0; }
  .modal-box table { font-size: 0.85rem; margin-bottom: 0; }
  #cooldownModalBody { overflow-y: auto; flex: 1; min-height: 0; overscroll-behavior: contain; }
  #cooldownModalBody td:last-child, #cooldownModalBody th:last-child { white-space: nowrap; }
  .modal-box.wide .modal-actions { flex-shrink: 0; padding-top: 0.9rem; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  .quota-panel { padding: 0.6rem 0 0.9rem; font-size: 0.85rem; }
  .quota-panel table { font-size: 0.82rem; margin-bottom: 0; }
  .quota-panel .empty-note { opacity: 0.65; }
  .quota-bar {
    display: inline-block; width: 80px; height: 6px; background: rgba(127,127,127,0.25);
    border-radius: 4px; overflow: hidden; vertical-align: middle; margin-right: 0.4rem;
  }
  .quota-bar-fill { height: 100%; }
  .quota-pct { vertical-align: middle; opacity: 0.85; }
  #status {
    position: fixed; left: 50%; bottom: 1.5rem; transform: translateX(-50%) translateY(8px);
    background: #1c1c1cf0; color: #fff; padding: 0.65rem 1.15rem; border-radius: 8px;
    font-size: 0.85rem; box-shadow: 0 8px 24px rgba(0,0,0,0.35); max-width: min(90vw, 440px);
    text-align: center; opacity: 0; pointer-events: none; z-index: 50;
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  #status.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>
  <h1>gemini-proxy</h1>
  <div class="sub">OpenAI-compatible multi-account Gemini proxy — local only.</div>

  <div class="baseurl">
    <span>Base URL: <code id="baseUrl" class="mono"></code> · no API key required</span>
    <button onclick="copyBaseUrl()">Copy</button>
  </div>

  <h2 style="font-size:1rem;">Accounts</h2>
  <table id="accountsTable">
    <thead><tr><th>Backend</th><th>Identity</th><th>Status</th><th>Cooling down</th><th>Added</th><th></th></tr></thead>
    <tbody></tbody>
  </table>
  <div id="emptyState" class="empty" style="display:none;">No accounts yet — add one below.</div>

  <div class="add-row">
    <button id="oauthBtn" class="primary" onclick="startOAuth()">+ Add Google account (OAuth)</button>
    <button onclick="toggleApiKeyForm()">+ Add AI Studio API key</button>
  </div>
  <div id="apikeyForm">
    <input id="apikeyInput" type="text" placeholder="AIza..." size="40" />
    <input id="apikeyLabel" type="text" placeholder="label (optional)" size="16" />
    <button class="primary" onclick="submitApiKey()">Add</button>
  </div>

  <div id="status"></div>

  <div class="warn">
    <strong>Note:</strong> Antigravity OAuth accounts use Google's internal, undocumented Code Assist API —
    this may violate Google's Terms of Service and carries account-suspension risk. Use a throwaway account,
    not your primary one. AI Studio API keys are the official, ToS-safe alternative.
  </div>

  <div id="modalOverlay" class="modal-overlay">
    <div class="modal-box">
      <p id="modalMessage"></p>
      <div class="modal-actions">
        <button id="modalCancelBtn">Cancel</button>
        <button id="modalConfirmBtn" class="danger">Remove</button>
      </div>
    </div>
  </div>

  <div id="cooldownModalOverlay" class="modal-overlay">
    <div class="modal-box wide">
      <h3 id="cooldownModalTitle"></h3>
      <div id="cooldownModalBody"></div>
      <div class="modal-actions">
        <button id="cooldownModalCloseBtn">Close</button>
      </div>
    </div>
  </div>

<script>
// Must match MANUAL_DISABLE_REASON in src/routes/admin.ts — used to tell an
// intentional user disable apart from an auto-disable due to a real error.
const MANUAL_DISABLE_REASON = 'Disabled manually.';

const baseUrlEl = document.getElementById('baseUrl');
baseUrlEl.textContent = location.origin + '/v1';

// Fixed-position toast (see #status CSS) rather than an inline status line —
// with a growing accounts table, an inline line could sit scrolled out of
// view of whatever row the user just clicked on, making feedback (e.g. from
// the "test" button) look like it did nothing when it actually just wasn't
// visible.
let statusTimer = null;
function setStatus(msg, isError) {
  const el = document.getElementById('status');
  el.textContent = msg || '';
  el.style.color = isError ? '#ff7b72' : '#fff';
  if (statusTimer) clearTimeout(statusTimer);
  if (!msg) {
    el.classList.remove('visible');
    return;
  }
  el.classList.add('visible');
  statusTimer = setTimeout(() => el.classList.remove('visible'), 4000);
}

function copyBaseUrl() {
  navigator.clipboard.writeText(baseUrlEl.textContent);
  setStatus('Copied.');
}

// The real key is never part of the regular account list (redact() strips
// it, and that list is what's polled/rendered from) — fetched fresh here
// only for the moment a copy is actually clicked, so it doesn't otherwise
// sit in the page.
async function copyApiKey(accountId, cell) {
  const original = cell.textContent;
  cell.textContent = 'copying…';
  try {
    const res = await fetch('/admin/accounts/' + accountId + '/key');
    const data = await res.json();
    if (!res.ok || !data.apiKey) {
      setStatus('Could not retrieve key: ' + (data.error || 'unknown error'), true);
      return;
    }
    await navigator.clipboard.writeText(data.apiKey);
    setStatus('Copied full API key to clipboard.');
  } catch (err) {
    setStatus('Copy failed: ' + err, true);
  } finally {
    cell.textContent = original;
  }
}

function toggleApiKeyForm() {
  const form = document.getElementById('apikeyForm');
  form.style.display = form.style.display === 'flex' ? 'none' : 'flex';
}

// Data is fetched on a slower interval (and immediately after any mutation);
// countdowns tick down live every second from this cached copy (see
// tickCountdowns) without hammering the server or rebuilding the table.
let latestData = { accounts: [], cooldowns: [], modelsByBackend: {} };

function humanizeDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (s < 3600) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(s / 3600);
  if (s < 86400) return h + 'h ' + (Math.floor(s / 60) % 60) + 'm';
  const d = Math.floor(s / 86400);
  return d + 'd ' + (Math.floor(s / 3600) % 24) + 'h';
}

async function refreshData() {
  const res = await fetch('/admin/accounts');
  const data = await res.json();
  // Skip the rebuild when nothing actually changed — every 10s poll
  // otherwise recreates every row's DOM node unconditionally, which resets
  // any :hover state (e.g. a tooltip) sitting under the mouse and makes it
  // flash even though nothing about the account list actually changed.
  const changed = JSON.stringify(data) !== JSON.stringify(latestData);
  latestData = data;
  if (changed) render();
}

// Which account's quota panel (if any) is expanded, and what it last fetched.
// Separate from latestData/refreshData since quota is fetched on demand
// (per account, lazily) rather than on the same poll cycle as the account list.
let expandedQuotaAccountId = null;
let quotaState = {}; // accountId -> { status: 'loading'|'ready'|'error', models?, note?, error? }

function quotaColor(fraction) {
  if (fraction >= 0.5) return '#1a7f37';
  if (fraction >= 0.2) return '#9a6700';
  return '#cf222e';
}

async function toggleQuota(accountId) {
  if (expandedQuotaAccountId === accountId) {
    expandedQuotaAccountId = null;
    render();
    return;
  }
  expandedQuotaAccountId = accountId;
  const stale = !quotaState[accountId] || quotaState[accountId].status === 'error';
  if (stale) {
    quotaState[accountId] = { status: 'loading' };
    render();
    try {
      const res = await fetch('/admin/accounts/' + accountId + '/models');
      const data = await res.json();
      quotaState[accountId] = data.error
        ? { status: 'error', error: data.error }
        : { status: 'ready', models: data.models, note: data.note };
    } catch (err) {
      quotaState[accountId] = { status: 'error', error: String(err) };
    }
  }
  render();
}

function buildQuotaPanel(accountId) {
  const state = quotaState[accountId];
  const wrap = document.createElement('div');
  wrap.className = 'quota-panel';

  if (!state || state.status === 'loading') {
    wrap.innerHTML = '<span class="empty-note">Loading model quota…</span>';
    return wrap;
  }
  if (state.status === 'error') {
    wrap.textContent = 'Failed to load quota: ' + state.error;
    wrap.style.color = '#cf222e';
    return wrap;
  }
  if (state.note) {
    wrap.innerHTML = '<span class="empty-note">' + escapeHtml(state.note) + '</span>';
    return wrap;
  }
  if (!state.models || state.models.length === 0) {
    wrap.innerHTML = '<span class="empty-note">No models returned.</span>';
    return wrap;
  }

  // Lowest remaining quota first, so anything close to exhausted is what you see immediately.
  const models = [...state.models].sort((a, b) => {
    const fa = a.quotaInfo && a.quotaInfo.remainingFraction !== undefined ? a.quotaInfo.remainingFraction : 1;
    const fb = b.quotaInfo && b.quotaInfo.remainingFraction !== undefined ? b.quotaInfo.remainingFraction : 1;
    return fa - fb;
  });

  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Model</th><th>Quota remaining</th><th>Resets in</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const m of models) {
    const frac = m.quotaInfo ? m.quotaInfo.remainingFraction : undefined;
    const pct = frac !== undefined && frac !== null ? Math.round(frac * 100) : null;
    const resetTimeMs = resetTime ? new Date(resetTime).getTime() : null;
    const resetsIn = resetTimeMs ? humanizeDuration((resetTimeMs - Date.now()) / 1000) : '—';
    // data-reset-time lets tickCountdowns() update just this cell every
    // second instead of the whole table being rebuilt (see tickCountdowns).
    const resetsAttr = resetTimeMs ? ' data-reset-time="' + resetTimeMs + '"' : '';
    const barHtml = pct !== null
      ? '<div class="quota-bar"><div class="quota-bar-fill" style="width:' + pct + '%;background:' + quotaColor(frac) + '"></div></div><span class="quota-pct">' + pct + '%</span>'
      : '<span class="empty-note">n/a</span>';
    const row = document.createElement('tr');
    row.innerHTML =
      '<td class="mono">' + escapeHtml(m.id) + '</td>' +
      '<td>' + barHtml + '</td>' +
      '<td' + resetsAttr + '>' + resetsIn + '</td>';
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function render() {
  const data = latestData;
  const tbody = document.querySelector('#accountsTable tbody');
  tbody.innerHTML = '';
  document.getElementById('emptyState').style.display = data.accounts.length === 0 ? 'block' : 'none';

  const cooldownsByAccount = {};
  for (const cd of data.cooldowns) {
    (cooldownsByAccount[cd.accountId] ||= []).push(cd);
  }

  // OAuth accounts are preferred by rotation (see README "How rotation
  // works"), so show them first here too — stable sort keeps each group in
  // its original (add-order) sequence.
  const sortedAccounts = [...data.accounts].sort((a, b) => {
    const rank = (acc) => (acc.backend === 'antigravity' ? 0 : 1);
    return rank(a) - rank(b);
  });

  for (const acc of sortedAccounts) {
    const tr = document.createElement('tr');
    const identity = acc.backend === 'antigravity' ? (acc.email || '(pending)') : (acc.label || acc.apiKeyMasked);
    // Cooldowns whose until timestamp is already in the past are stale (the
    // server just hasn't swept them yet) — treat them as already expired
    // rather than showing them as still cooling down.
    const cds = (cooldownsByAccount[acc.id] || []).filter(c => c.until > Date.now());
    // "Exhausted" only when literally every model this backend currently
    // serves is cooling down on this account — otherwise the account is
    // still fully usable, just not for those specific models, so it stays
    // "active" with a small warning icon rather than reading as unusable.
    const catalog = data.modelsByBackend[acc.backend] || [];
    const coolingModels = new Set(cds.map(c => c.model));
    const fullyExhausted = cds.length > 0 && catalog.length > 0 && catalog.every(m => coolingModels.has(m));
    const activeModels = catalog.filter(m => !coolingModels.has(m));
    let statusHtml;
    let coolingHtml = '<span class="muted">—</span>';
    if (acc.disabled) {
      // A manual disable is an intentional, no-action-needed state, so it
      // gets a neutral badge — only a genuine auto-disable (auth failure,
      // rejected key) reads as "needs attention" in red.
      statusHtml = acc.disabledReason === MANUAL_DISABLE_REASON
        ? '<span class="badge disabled">disabled</span>'
        : '<span class="badge bad" data-tooltip="' + escapeHtml(acc.disabledReason || 'Unknown reason') + '">needs attention</span>';
    } else if (fullyExhausted) {
      const soonest = Math.min(...cds.map(c => c.until));
      const remaining = humanizeDuration((soonest - Date.now()) / 1000);
      // data-soonest lets tickCountdowns() update just this text node every
      // second instead of the whole table being rebuilt (see tickCountdowns).
      statusHtml = '<span class="badge exhausted" data-soonest="' + soonest + '">exhausted (back in ' + remaining + ')</span>';
    } else {
      // Clickable when we actually know which models this account currently
      // serves, so the modal has something to show — mirrors the cooldown
      // badge's click-for-detail pattern below. The count mirrors the
      // cooldown column's "N models" label for an at-a-glance comparison of
      // how many models are usable vs. cooling down.
      statusHtml = activeModels.length > 0
        ? '<span class="badge ok clickable">active — ' + escapeHtml(modelCountLabel(activeModels)) + '</span>'
        : '<span class="badge ok">active</span>';
    }
    if (cds.length > 0) {
      // Cooldowns are per (account, model) — surfaced in their own column so
      // "which models" never has to fight the status badge for space, and
      // shown regardless of exhausted/active so the detail modal isn't the
      // only place to see per-model detail. Click opens a modal with the
      // full per-model breakdown rather than a hover tooltip, since a
      // tooltip is hard to read/select-copy-from and doesn't work on touch.
      coolingHtml = '<span class="badge cooldown clickable">⏳ ' + escapeHtml(modelCountLabel(cds.map(c => c.model))) + '</span>';
    }
    const identityAttrs = acc.backend === 'apikey'
      ? ' class="mono copyable" data-tooltip="Click to copy full API key"'
      : ' class="mono"';
    tr.innerHTML =
      '<td>' + acc.backend + '</td>' +
      '<td' + identityAttrs + '>' + escapeHtml(identity) + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td>' + coolingHtml + '</td>' +
      '<td>' + new Date(acc.addedAt).toLocaleDateString() + '</td>' +
      '<td class="row-actions"></td>';
    if (acc.backend === 'apikey') {
      const identityCell = tr.querySelector('.copyable');
      identityCell.onclick = () => copyApiKey(acc.id, identityCell);
    }
    if (cds.length > 0) {
      const cooldownBadge = tr.querySelector('.badge.cooldown');
      cooldownBadge.onclick = () => showCooldownDetails(identity, cds);
    }
    if (activeModels.length > 0) {
      const statusBadge = tr.querySelector('.badge.ok');
      if (statusBadge) statusBadge.onclick = () => showActiveModels(identity, activeModels);
    }
    const actions = tr.querySelector('.row-actions');
    if (acc.disabled) {
      const reBtn = document.createElement('button');
      reBtn.textContent = 're-enable';
      reBtn.onclick = () => reenable(acc.id);
      actions.appendChild(reBtn);
    } else {
      const disBtn = document.createElement('button');
      disBtn.textContent = 'disable';
      disBtn.onclick = () => disableAccount(acc.id);
      actions.appendChild(disBtn);
    }
    if (acc.backend === 'antigravity' && !acc.disabled) {
      const qBtn = document.createElement('button');
      qBtn.textContent = expandedQuotaAccountId === acc.id ? 'hide quota' : 'quota';
      qBtn.onclick = () => toggleQuota(acc.id);
      actions.appendChild(qBtn);
    }
    if (acc.backend === 'apikey' && !acc.disabled) {
      const tBtn = document.createElement('button');
      tBtn.textContent = 'test';
      tBtn.onclick = () => testApiKey(acc.id, tBtn);
      actions.appendChild(tBtn);
    }
    const rmBtn = document.createElement('button');
    rmBtn.className = 'danger';
    rmBtn.textContent = 'remove';
    rmBtn.onclick = () => removeAccount(acc.id);
    actions.appendChild(rmBtn);
    tbody.appendChild(tr);

    if (expandedQuotaAccountId === acc.id) {
      const detailTr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.appendChild(buildQuotaPanel(acc.id));
      detailTr.appendChild(td);
      tbody.appendChild(detailTr);
    }
  }
}

// Kept as the name the rest of the code calls after a mutation (add/remove/etc).
async function refresh() {
  await refreshData();
}

function modelCountLabel(names) {
  return names.length <= 2 ? names.join(', ') : names.length + ' models';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// The overlay covers the full viewport but has nothing of its own to
// scroll, so a wheel/trackpad scroll over it (or reaching the top/bottom of
// a modal's own scrollable content) otherwise falls through to the page
// underneath. Locking body scroll while any modal is open keeps scrolling
// confined to the modal itself.
let modalOpenCount = 0;
function lockBodyScroll() {
  if (modalOpenCount++ === 0) document.body.style.overflow = 'hidden';
}
function unlockBodyScroll() {
  if (--modalOpenCount <= 0) {
    modalOpenCount = 0;
    document.body.style.overflow = '';
  }
}

function showConfirm(message, confirmLabel) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    const confirmBtn = document.getElementById('modalConfirmBtn');
    const cancelBtn = document.getElementById('modalCancelBtn');
    document.getElementById('modalMessage').textContent = message;
    confirmBtn.textContent = confirmLabel || 'Confirm';
    overlay.style.display = 'flex';
    lockBodyScroll();
    confirmBtn.focus();

    function cleanup(result) {
      overlay.style.display = 'none';
      unlockBodyScroll();
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      overlay.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') cleanup(false);
    }
    confirmBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    document.addEventListener('keydown', onKey);
  });
}

function openDetailModal(title, bodyHtml) {
  const overlay = document.getElementById('cooldownModalOverlay');
  const closeBtn = document.getElementById('cooldownModalCloseBtn');
  document.getElementById('cooldownModalTitle').textContent = title;
  document.getElementById('cooldownModalBody').innerHTML = bodyHtml;
  overlay.style.display = 'flex';
  lockBodyScroll();
  closeBtn.focus();

  function cleanup() {
    overlay.style.display = 'none';
    unlockBodyScroll();
    closeBtn.onclick = null;
    overlay.onclick = null;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') cleanup();
  }
  closeBtn.onclick = cleanup;
  overlay.onclick = (e) => { if (e.target === overlay) cleanup(); };
  document.addEventListener('keydown', onKey);
}

function showCooldownDetails(identity, cds) {
  const sorted = [...cds].sort((a, b) => a.until - b.until);
  openDetailModal('Cooling down — ' + identity,
    '<table><thead><tr><th>Model</th><th>Reason</th><th>Back in</th></tr></thead><tbody>' +
    sorted.map(c =>
      '<tr><td class="mono">' + escapeHtml(c.model) + '</td>' +
      '<td>' + escapeHtml(c.reason || 'unknown reason') + '</td>' +
      '<td>' + humanizeDuration((c.until - Date.now()) / 1000) + '</td></tr>'
    ).join('') +
    '</tbody></table>');
}

function showActiveModels(identity, models) {
  const sorted = [...models].sort();
  openDetailModal('Active models — ' + identity,
    '<table><thead><tr><th>Model</th></tr></thead><tbody>' +
    sorted.map(m => '<tr><td class="mono">' + escapeHtml(m) + '</td></tr>').join('') +
    '</tbody></table>');
}

async function removeAccount(id) {
  const ok = await showConfirm('Remove this account? This can\\'t be undone.', 'Remove');
  if (!ok) return;
  await fetch('/admin/accounts/' + id, { method: 'DELETE' });
  refresh();
}

async function reenable(id) {
  await fetch('/admin/accounts/' + id + '/reenable', { method: 'POST' });
  refresh();
}

async function disableAccount(id) {
  const ok = await showConfirm('Disable this account? It won\\'t be used for any requests until you re-enable it.', 'Disable');
  if (!ok) return;
  await fetch('/admin/accounts/' + id + '/disable', { method: 'POST' });
  refresh();
}

async function testApiKey(id, btn) {
  const original = btn.textContent;
  btn.textContent = 'testing...';
  btn.disabled = true;
  try {
    const res = await fetch('/admin/accounts/' + id + '/test', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      setStatus('Test passed.');
    } else {
      setStatus('Test failed: ' + (data.reason || 'unknown reason'), true);
    }
  } finally {
    btn.textContent = original;
    btn.disabled = false;
    refresh();
  }
}

async function submitApiKey() {
  const apiKey = document.getElementById('apikeyInput').value.trim();
  const label = document.getElementById('apikeyLabel').value.trim();
  if (!apiKey) return;
  const res = await fetch('/admin/accounts/apikey', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, label }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    setStatus(data.error?.message || 'Could not add this API key.', true);
    return;
  }
  document.getElementById('apikeyInput').value = '';
  document.getElementById('apikeyLabel').value = '';
  toggleApiKeyForm();
  setStatus('API key added.');
  refresh();
}

let oauthInFlight = false;

async function startOAuth() {
  // Guards against a double-click firing two flows that race for the single
  // fixed local OAuth callback port — the second one would otherwise show a
  // confusing "link expired" error. The server also guards against this
  // independently (it reuses an in-flight flow rather than starting a
  // second one), so this is belt-and-suspenders for the common case.
  if (oauthInFlight) return;
  oauthInFlight = true;
  const btn = document.getElementById('oauthBtn');
  btn.disabled = true;

  try {
    setStatus('Opening Google sign-in…');
    const res = await fetch('/admin/oauth/start', { method: 'POST' });
    const { authUrl, state } = await res.json();
    const popup = window.open(authUrl, '_blank', 'width=520,height=680');
    if (!popup) {
      setStatus('Popup blocked — open this URL manually: ' + authUrl);
    }
    await poll(state);
  } finally {
    oauthInFlight = false;
    btn.disabled = false;
  }
}

async function poll(state) {
  const res = await fetch('/admin/oauth/status/' + state);
  const data = await res.json();
  if (data.status === 'pending') {
    setStatus('Waiting for sign-in to complete…');
    await new Promise(r => setTimeout(r, 1500));
    return poll(state);
  }
  if (data.status === 'done') {
    setStatus('Added ' + (data.email || 'account') + '.');
    refresh();
    return;
  }
  setStatus('Sign-in failed: ' + (data.error || 'unknown error'), true);
}

// Updates just the live countdown text nodes in place (see the
// data-soonest/data-reset-time attributes above) rather than rebuilding the
// whole table every second like render() does — a full rebuild recreates
// every DOM node, which drops :hover state and makes any tooltip under the
// mouse flash on and off once a second.
function tickCountdowns() {
  const now = Date.now();
  for (const badge of document.querySelectorAll('.badge.exhausted[data-soonest]')) {
    const soonest = Number(badge.dataset.soonest);
    badge.textContent = 'exhausted (back in ' + humanizeDuration((soonest - now) / 1000) + ')';
  }
  for (const td of document.querySelectorAll('td[data-reset-time]')) {
    const resetTime = Number(td.dataset.resetTime);
    td.textContent = humanizeDuration((resetTime - now) / 1000);
  }
}

refreshData();
setInterval(refreshData, 10000);   // full re-fetch (status/cooldown changes, new accounts, etc.)
setInterval(tickCountdowns, 1000); // live countdown tick from the cached data, no extra requests, no DOM rebuild
</script>
</body>
</html>`;

export function renderUI(): Response {
  return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
}

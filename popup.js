const DEFAULTS = { enabled: true, maxRetries: 1000, retryDelaySec: 5, notify: true };

const els = {
  enabled: document.getElementById("enabled"),
  retryDelaySec: document.getElementById("retryDelaySec"),
  maxRetries: document.getElementById("maxRetries"),
  notify: document.getElementById("notify"),
  list: document.getElementById("list"),
  cancelAll: document.getElementById("cancelAll"),
  clearAll: document.getElementById("clearAll"),
  cancelCount: document.getElementById("cancelCount"),
  clearCount: document.getElementById("clearCount"),
};

const ICON_STOP =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
const ICON_TRASH =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;

const isRunning = (it) => it.state === "in_progress";

const expanded = new Set();       // ids (as strings) whose detail is open
const samples = {};               // id -> [{t, bytes}] for speed calc
let currentItems = [];            // the rows currently shown, for bulk actions

// ---------- formatting ----------
function fmtBytes(n) {
  if (!n || n < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return "—";
  return `${fmtBytes(bps)}/s`;
}
function fmtDuration(sec) {
  if (!isFinite(sec) || sec < 0) return "—";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function fmtClock(t) {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}
function baseName(item) {
  if (!item.filename) {
    try { return decodeURIComponent(new URL(item.url).pathname.split("/").pop()) || item.url; }
    catch { return item.url; }
  }
  return item.filename.split(/[\\/]/).pop();
}

// ---------- settings ----------
async function loadConfig() {
  const { config } = await chrome.storage.local.get("config");
  const cfg = { ...DEFAULTS, ...(config || {}) };
  els.enabled.checked = cfg.enabled;
  els.retryDelaySec.value = cfg.retryDelaySec;
  els.maxRetries.value = cfg.maxRetries;
  els.notify.checked = cfg.notify;
}
async function saveConfig() {
  const cfg = {
    enabled: els.enabled.checked,
    retryDelaySec: Math.max(1, parseInt(els.retryDelaySec.value, 10) || DEFAULTS.retryDelaySec),
    maxRetries: Math.max(1, parseInt(els.maxRetries.value, 10) || DEFAULTS.maxRetries),
    notify: els.notify.checked,
  };
  await chrome.storage.local.set({ config: cfg });
}
for (const el of [els.enabled, els.retryDelaySec, els.maxRetries, els.notify]) {
  el.addEventListener("change", saveConfig);
}

// ---------- speed sampling ----------
function recordSample(item) {
  const id = String(item.id);
  const active = item.state === "in_progress" && !item.paused;
  if (!active) { delete samples[id]; return 0; }
  const now = Date.now();
  const arr = samples[id] || [];
  arr.push({ t: now, bytes: item.bytesReceived });
  while (arr.length > 8) arr.shift();
  samples[id] = arr;
  if (arr.length < 2) return 0;
  const first = arr[0], last = arr[arr.length - 1];
  const dt = (last.t - first.t) / 1000;
  const db = last.bytes - first.bytes;
  return dt > 0 ? db / dt : 0;
}

// ---------- status + events ----------
function statusFor(item) {
  if (item.state === "complete") return { cls: "done", label: "Complete" };
  if (item.state === "in_progress") {
    if (item.paused) return { cls: "wait", label: "Paused" };
    return { cls: "live", label: "Downloading" };
  }
  if (item.error === "USER_CANCELED") return { cls: "dead", label: "Canceled" };
  if (item.canResume) return { cls: "wait", label: `Retrying — ${item.error || "dropped"}` };
  return { cls: "dead", label: `Stopped — ${item.error || "can't resume"}` };
}

const EV = {
  created:   { label: "Started",     c: "faint" },
  hiccup:    { label: "Dropped",     c: "dead" },
  retry:     { label: "Retry",       c: "wait" },
  recovered: { label: "Resumed",     c: "live" },
  complete:  { label: "Completed",   c: "accent" },
  canceled:  { label: "Canceled",    c: "dead" },
  stopped:   { label: "Can't resume", c: "dead" },
  gave_up:   { label: "Gave up",     c: "dead" },
};

function renderEvents(log) {
  if (!log || log.length === 0) return `<div class="ev-empty">No events yet.</div>`;
  const rows = [];
  for (let i = log.length - 1; i >= 0; i--) {          // newest first
    const e = log[i];
    const meta = EV[e.type] || { label: e.type, c: "faint" };
    let lab = meta.label;
    if (e.type === "retry" && e.attempt) lab = `Retry #${e.attempt}`;
    let ctx = "";
    if (e.type === "hiccup") ctx = `${e.error || "error"}${e.bytes ? " · " + fmtBytes(e.bytes) : ""}`;
    else if (typeof e.bytes === "number" && e.bytes > 0) ctx = fmtBytes(e.bytes);
    rows.push(
      `<div class="ev">
         <span class="t">${fmtClock(e.t)}</span>
         <span class="lab ${meta.c}">${lab}</span>
         <span class="ctx" title="${ctx}">${ctx}</span>
       </div>`
    );
  }
  return rows.join("");
}

function renderDetail(item, speed, log) {
  const total = item.totalBytes > 0 ? item.totalBytes : 0;
  const remainingBytes = total ? Math.max(0, total - item.bytesReceived) : 0;

  let eta = "—";
  if (item.state === "in_progress" && !item.paused) {
    if (speed > 0 && total) eta = fmtDuration(remainingBytes / speed);
    else if (item.estimatedEndTime) {
      eta = fmtDuration((new Date(item.estimatedEndTime).getTime() - Date.now()) / 1000);
    }
  }

  const hiccups = (log || []).filter((e) => e.type === "hiccup").length;
  const retries = (log || []).filter((e) => e.type === "retry").length;
  const started = (log && log[0]) ? fmtClock(log[0].t)
                : (item.startTime ? fmtClock(new Date(item.startTime).getTime()) : "—");

  return `
    <div class="detail">
      <div class="stats">
        <div class="stat"><span class="k">Speed</span><span class="v">${item.state === "in_progress" && !item.paused ? fmtSpeed(speed) : "—"}</span></div>
        <div class="stat"><span class="k">Time left</span><span class="v">${eta}</span></div>
        <div class="stat"><span class="k">Downloaded</span><span class="v">${fmtBytes(item.bytesReceived)}${total ? " / " + fmtBytes(total) : ""}</span></div>
        <div class="stat"><span class="k">Started</span><span class="v">${started}</span></div>
        <div class="stat"><span class="k">Hiccups</span><span class="v ${hiccups ? "warn" : ""}">${hiccups}</span></div>
        <div class="stat"><span class="k">Retries</span><span class="v ${retries ? "warn" : ""}">${retries}</span></div>
      </div>
      <div class="events-label">History</div>
      <div class="events">${renderEvents(log)}</div>
    </div>`;
}

const CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

// ---------- main render ----------
async function renderList() {
  const [{ eventLog }, items] = await Promise.all([
    chrome.storage.local.get("eventLog"),
    chrome.downloads.search({ orderBy: ["-startTime"], limit: 25 }),
  ]);
  const logs = eventLog || {};

  const recent = items.filter((it) => {
    if (it.state === "in_progress" || it.state === "interrupted") return true;
    if (it.state === "complete" && it.endTime) {
      return Date.now() - new Date(it.endTime).getTime() < 120000;
    }
    return false;
  });

  currentItems = recent;
  updateToolbar();

  if (recent.length === 0) {
    els.list.innerHTML =
      `<div class="empty">No active downloads. Start a download as usual — if it drops, <b>Resumer</b> continues it automatically.</div>`;
    return;
  }

  const scrollTop = els.list.scrollTop;
  const html = [];
  for (const item of recent) {
    const id = String(item.id);
    const st = statusFor(item);
    const speed = recordSample(item);
    const total = item.totalBytes > 0 ? item.totalBytes : 0;
    const pct = total ? Math.min(100, (item.bytesReceived / total) * 100) : 0;
    const barColor = st.cls === "done" ? "accent" : st.cls === "dead" ? "dead" : st.cls === "wait" ? "wait" : "live";
    const log = logs[id] || [];
    const hiccups = log.filter((e) => e.type === "hiccup").length;
    const open = expanded.has(id);

    html.push(
      `<div class="row ${open ? "open" : ""}" data-id="${id}">
         <div class="row-top">
           <span class="dot ${st.cls}"></span>
           <span class="fname" title="${baseName(item)}">${baseName(item)}</span>
           ${hiccups ? `<span class="retries">${hiccups}⚡</span>` : ""}
           ${isRunning(item)
             ? `<button class="act cancel" data-act="cancel" data-id="${id}" title="Cancel download" aria-label="Cancel download">${ICON_STOP}</button>`
             : `<button class="act clear" data-act="clear" data-id="${id}" title="Clear from list" aria-label="Clear from list">${ICON_TRASH}</button>`}
           <button class="toggle" data-id="${id}" aria-label="Details" aria-expanded="${open}">${CHEVRON}</button>
         </div>
         <div class="bar"><i style="width:${pct}%; background:var(--${barColor})"></i></div>
         <div class="meta">
           <span class="status-text">${st.label}</span>
           <span>${fmtBytes(item.bytesReceived)}${total ? " / " + fmtBytes(total) : ""}</span>
         </div>
         ${open ? renderDetail(item, speed, log) : ""}
       </div>`
    );
  }
  els.list.innerHTML = html.join("");
  els.list.scrollTop = scrollTop;
}

// ---------- actions ----------
async function purgeStorageFor(id) {
  const store = await chrome.storage.local.get(["eventLog", "retryState"]);
  const log = store.eventLog || {};
  const retry = store.retryState || {};
  let changed = false;
  if (log[id]) { delete log[id]; changed = true; }
  if (retry[id]) { delete retry[id]; changed = true; }
  if (changed) await chrome.storage.local.set({ eventLog: log, retryState: retry });
}

function cancelDownload(id) {
  return new Promise((res) => chrome.downloads.cancel(Number(id), () => { void chrome.runtime.lastError; res(); }));
}
async function clearDownload(id) {
  await new Promise((res) => chrome.downloads.erase({ id: Number(id) }, () => { void chrome.runtime.lastError; res(); }));
  expanded.delete(String(id));
  delete samples[String(id)];
  await purgeStorageFor(String(id));
}

// Row buttons via delegation (survives the 1s re-render).
els.list.addEventListener("click", async (e) => {
  const act = e.target.closest(".act");
  if (act) {
    const id = act.dataset.id;
    if (act.dataset.act === "cancel") await cancelDownload(id);
    else await clearDownload(id);
    renderList();
    return;
  }
  const btn = e.target.closest(".toggle");
  if (!btn) return;
  const id = btn.dataset.id;
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  renderList();
});

// Bulk actions — operate on exactly the rows currently in view.
els.cancelAll.addEventListener("click", async () => {
  const running = currentItems.filter(isRunning);
  await Promise.all(running.map((it) => cancelDownload(it.id)));
  renderList();
});
els.clearAll.addEventListener("click", async () => {
  const stopped = currentItems.filter((it) => !isRunning(it));
  await Promise.all(stopped.map((it) => clearDownload(it.id)));
  renderList();
});

function updateToolbar() {
  const running = currentItems.filter(isRunning).length;
  const stopped = currentItems.length - running;
  els.cancelAll.disabled = running === 0;
  els.clearAll.disabled = stopped === 0;
  els.cancelCount.textContent = running ? `(${running})` : "";
  els.clearCount.textContent = stopped ? `(${stopped})` : "";
}

loadConfig();
renderList();
setInterval(renderList, 1000);

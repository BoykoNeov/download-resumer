const DEFAULTS = { enabled: true, maxRetries: 1000, retryDelaySec: 5, maxRetryDelaySec: 300, notify: true };

const els = {
  enabled: document.getElementById("enabled"),
  retryDelaySec: document.getElementById("retryDelaySec"),
  maxRetryDelaySec: document.getElementById("maxRetryDelaySec"),
  maxRetries: document.getElementById("maxRetries"),
  notify: document.getElementById("notify"),
  newUrl: document.getElementById("newUrl"),
  startDownload: document.getElementById("startDownload"),
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
const ICON_PAUSE =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;
const ICON_PLAY =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5v14l12-7z"/></svg>`;

const isRunning = (it) => it.state === "in_progress";

const expanded = new Set();       // ids (as strings) whose detail is open
const samples = {};               // id -> [{t, bytes}] for speed calc
const speedHistory = {};          // id -> [bps,...] for the detail sparkline
const SPARK_LEN = 30;             // ~30s of history at the 1s render interval
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
  els.maxRetryDelaySec.value = cfg.maxRetryDelaySec;
  els.maxRetries.value = cfg.maxRetries;
  els.notify.checked = cfg.notify;
}
async function saveConfig() {
  const cfg = {
    enabled: els.enabled.checked,
    retryDelaySec: Math.max(1, parseInt(els.retryDelaySec.value, 10) || DEFAULTS.retryDelaySec),
    maxRetryDelaySec: Math.max(1, parseInt(els.maxRetryDelaySec.value, 10) || DEFAULTS.maxRetryDelaySec),
    maxRetries: Math.max(1, parseInt(els.maxRetries.value, 10) || DEFAULTS.maxRetries),
    notify: els.notify.checked,
  };
  await chrome.storage.local.set({ config: cfg });
}
for (const el of [els.enabled, els.retryDelaySec, els.maxRetryDelaySec, els.maxRetries, els.notify]) {
  el.addEventListener("change", saveConfig);
}

// ---------- speed sampling ----------
function recordSample(item) {
  const id = String(item.id);
  const active = item.state === "in_progress" && !item.paused;
  if (!active) { delete samples[id]; delete speedHistory[id]; return 0; }
  const now = Date.now();
  const arr = samples[id] || [];
  arr.push({ t: now, bytes: item.bytesReceived });
  while (arr.length > 8) arr.shift();
  samples[id] = arr;
  let speed = 0;
  if (arr.length >= 2) {
    const first = arr[0], last = arr[arr.length - 1];
    const dt = (last.t - first.t) / 1000;
    const db = last.bytes - first.bytes;
    speed = dt > 0 ? db / dt : 0;
  }
  const hist = speedHistory[id] || [];
  hist.push(speed);
  while (hist.length > SPARK_LEN) hist.shift();
  speedHistory[id] = hist;
  return speed;
}

function renderSparkline(id) {
  const hist = speedHistory[id] || [];
  if (hist.length < 2) return "";
  const max = Math.max(...hist, 1);
  const w = 100, h = 28;
  const stepX = w / (hist.length - 1);
  const points = hist
    .map((v, i) => `${(i * stepX).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${points}"/></svg>`;
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

function buildLogText(item, log) {
  const lines = [];
  if (item) {
    lines.push(baseName(item));
    if (item.url) lines.push(item.url);
    lines.push("");
  }
  if (!log || log.length === 0) {
    lines.push("No events yet.");
  } else {
    for (const e of log) {
      const meta = EV[e.type] || { label: e.type };
      let line = `${new Date(e.t).toISOString()}  ${meta.label}`;
      if (e.type === "retry" && e.attempt) line += ` #${e.attempt}`;
      if (e.error) line += `  (${e.error})`;
      if (typeof e.bytes === "number") line += `  ${fmtBytes(e.bytes)}`;
      lines.push(line);
    }
  }
  return lines.join("\n");
}

function renderDetail(item, speed, log, retryEntry) {
  const id = String(item.id);
  const total = item.totalBytes > 0 ? item.totalBytes : 0;
  const remainingBytes = total ? Math.max(0, total - item.bytesReceived) : 0;
  const running = item.state === "in_progress" && !item.paused;

  let eta = "—";
  if (running) {
    if (speed > 0 && total) eta = fmtDuration(remainingBytes / speed);
    else if (item.estimatedEndTime) {
      eta = fmtDuration((new Date(item.estimatedEndTime).getTime() - Date.now()) / 1000);
    }
  }

  const hiccups = (log || []).filter((e) => e.type === "hiccup").length;
  const retries = (log || []).filter((e) => e.type === "retry").length;
  const started = (log && log[0]) ? fmtClock(log[0].t)
                : (item.startTime ? fmtClock(new Date(item.startTime).getTime()) : "—");

  // Live countdown to the next scheduled resume, from background.js's
  // exponential-backoff schedule (retryState.nextAt). Shown so the growing
  // wait between attempts is actually visible, rather than only reflected in
  // the "Wait between retries" setting (which is the base delay, not the
  // current backed-off one, and is shared across all downloads).
  let nextRetry = null;
  if (item.state === "interrupted" && item.canResume && retryEntry && retryEntry.pending && retryEntry.nextAt) {
    const secsLeft = Math.round((retryEntry.nextAt - Date.now()) / 1000);
    nextRetry = secsLeft > 0 ? `${secsLeft}s` : "any moment";
  }

  const spark = running ? renderSparkline(id) : "";

  return `
    <div class="detail">
      <div class="stats">
        <div class="stat"><span class="k">Speed</span><span class="v">${running ? fmtSpeed(speed) : "—"}</span></div>
        <div class="stat"><span class="k">Time left</span><span class="v">${eta}</span></div>
        <div class="stat"><span class="k">Downloaded</span><span class="v">${fmtBytes(item.bytesReceived)}${total ? " / " + fmtBytes(total) : ""}</span></div>
        <div class="stat"><span class="k">Started</span><span class="v">${started}</span></div>
        <div class="stat"><span class="k">Hiccups</span><span class="v ${hiccups ? "warn" : ""}">${hiccups}</span></div>
        <div class="stat"><span class="k">Retries</span><span class="v ${retries ? "warn" : ""}">${retries}</span></div>
        ${nextRetry ? `<div class="stat"><span class="k">Next retry</span><span class="v warn">${nextRetry}</span></div>` : ""}
      </div>
      ${running ? `<div class="spark-wrap">${spark || `<div class="spark-empty">Gathering speed data…</div>`}</div>` : ""}
      ${item.state === "complete" ? renderFileActions(id) : ""}
      ${item.state === "interrupted" ? renderRestart(id, item) : ""}
      <div class="events-label-row">
        <span class="events-label">History</span>
        <button class="copylog" data-id="${id}">Copy log</button>
      </div>
      <div class="events">${renderEvents(log)}</div>
    </div>`;
}

// Heuristic only: Chrome doesn't tell us a signed URL's token expired, but a
// 401/403 on a URL carrying the usual signed-URL query params (S3, GCS, Azure
// SAS, generic ?token=) is the classic shape of that failure. Worded as "may
// have" — this can also just be a server misconfiguration.
const AUTH_ERRORS = new Set(["SERVER_FORBIDDEN", "SERVER_UNAUTHORIZED"]);
const SIGNED_URL_PARAMS = /[?&](?:expires|x-amz-expires|x-amz-signature|x-goog-expires|x-goog-signature|signature|token|policy)=/i;

function looksLikeExpiredUrl(item) {
  return AUTH_ERRORS.has(item.error) && SIGNED_URL_PARAMS.test(item.url || "");
}

function renderFileActions(id) {
  return `
    <div class="file-actions">
      <button class="filebtn" data-act="open-file" data-id="${id}">Open file</button>
      <button class="filebtn" data-act="show-folder" data-id="${id}">Show in folder</button>
    </div>`;
}

function renderRestart(id, item) {
  const hint = looksLikeExpiredUrl(item)
    ? `<div class="expiry-hint">This link may have expired (${item.error}) — paste a fresh URL below to restart.</div>`
    : "";
  return `
    ${hint}
    <div class="restart-row">
      <input type="url" class="restart-input" data-id="${id}" placeholder="Restart from a fresh URL…" />
      <button class="restart-btn" data-id="${id}">Restart</button>
    </div>`;
}

const CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

// ---------- main render ----------
async function renderList() {
  // Rebuilding #list's innerHTML mid-keystroke would blow away focus and the
  // in-progress text, so skip this tick entirely while a restart URL is being typed.
  if (document.activeElement && document.activeElement.classList.contains("restart-input")) return;

  const [{ eventLog, retryState }, items] = await Promise.all([
    chrome.storage.local.get(["eventLog", "retryState"]),
    chrome.downloads.search({ orderBy: ["-startTime"], limit: 50 }),
  ]);
  const logs = eventLog || {};
  const retryStates = retryState || {};

  // No time-based decay: every active/interrupted/completed download stays
  // listed until explicitly cleared (individually or via Clear all), bounded
  // only by the search limit above. Active rows float to the top; everything
  // else keeps search()'s newest-started-first order.
  const relevant = items.filter((it) =>
    it.state === "in_progress" || it.state === "interrupted" || it.state === "complete"
  );
  const active = relevant.filter(isRunning);
  const others = relevant.filter((it) => !isRunning(it));
  const recent = [...active, ...others];

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
             ? `<button class="act ${item.paused ? "resume" : "pause"}" data-act="${item.paused ? "resume" : "pause"}" data-id="${id}" title="${item.paused ? "Resume download" : "Pause download"}" aria-label="${item.paused ? "Resume download" : "Pause download"}">${item.paused ? ICON_PLAY : ICON_PAUSE}</button>
               <button class="act cancel" data-act="cancel" data-id="${id}" title="Cancel download" aria-label="Cancel download">${ICON_STOP}</button>`
             : `<button class="act clear" data-act="clear" data-id="${id}" title="Clear from list" aria-label="Clear from list">${ICON_TRASH}</button>`}
           <button class="toggle" data-id="${id}" aria-label="Details" aria-expanded="${open}">${CHEVRON}</button>
         </div>
         <div class="bar"><i style="width:${pct}%; background:var(--${barColor})"></i></div>
         <div class="meta">
           <span class="status-text">${st.label}</span>
           <span>${fmtBytes(item.bytesReceived)}${total ? " / " + fmtBytes(total) : ""}</span>
         </div>
         ${open ? renderDetail(item, speed, log, retryStates[id]) : ""}
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
// Manual pause/resume for an actively running download. This is orthogonal to
// background.js's auto-resume: pausing keeps state "in_progress" (only
// `paused` flips), so it never touches the interrupted/retryState logic.
function pauseDownload(id) {
  return new Promise((res) => chrome.downloads.pause(Number(id), () => { void chrome.runtime.lastError; res(); }));
}
function resumeDownload(id) {
  return new Promise((res) => chrome.downloads.resume(Number(id), () => { void chrome.runtime.lastError; res(); }));
}
async function clearDownload(id) {
  await new Promise((res) => chrome.downloads.erase({ id: Number(id) }, () => { void chrome.runtime.lastError; res(); }));
  expanded.delete(String(id));
  delete samples[String(id)];
  delete speedHistory[String(id)];
  await purgeStorageFor(String(id));
}

function startDownload(url) {
  return new Promise((res) => {
    chrome.downloads.download({ url }, (id) => {
      const err = chrome.runtime.lastError;
      res({ ok: !err && id != null, error: err && err.message });
    });
  });
}

// Chrome's own resume() can't be redirected to a fresh URL and keep the partial
// file (confirmed empirically — declarativeNetRequest doesn't see resume()'s
// request), so "restart" here means a full re-download under the new URL,
// with the old dead entry cleared out from under it.
async function restartWithNewUrl(oldId, url) {
  const result = await startDownload(url);
  if (result.ok) await clearDownload(oldId);
  return result;
}

// Row buttons via delegation (survives the 1s re-render).
els.list.addEventListener("click", async (e) => {
  const fileBtn = e.target.closest(".filebtn");
  if (fileBtn) {
    // Must fire synchronously off the click (no prior await) — chrome.downloads.open()
    // requires an active user gesture and throws outside one.
    const id = Number(fileBtn.dataset.id);
    if (fileBtn.dataset.act === "open-file") chrome.downloads.open(id);
    else chrome.downloads.show(id);
    return;
  }
  const copyBtn = e.target.closest(".copylog");
  if (copyBtn) {
    const id = copyBtn.dataset.id;
    const item = currentItems.find((it) => String(it.id) === id);
    const { eventLog } = await chrome.storage.local.get("eventLog");
    const log = (eventLog || {})[id] || [];
    const text = buildLogText(item, log);
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied!";
    } catch {
      copyBtn.textContent = "Copy failed";
    }
    setTimeout(() => { copyBtn.textContent = "Copy log"; }, 1200);
    return;
  }
  const restartBtn = e.target.closest(".restart-btn");
  if (restartBtn) {
    const id = restartBtn.dataset.id;
    const input = els.list.querySelector(`.restart-input[data-id="${id}"]`);
    const url = input ? input.value.trim() : "";
    if (!url) { if (input) input.focus(); return; }
    restartBtn.disabled = true;
    restartBtn.textContent = "Restarting…";
    const result = await restartWithNewUrl(id, url);
    if (!result.ok) {
      // .restart-input lives inside #list, so renderList() would immediately
      // rebuild it and wipe any feedback set here — leave the row as-is
      // (button re-enabled, URL still typed) so the user can retry.
      restartBtn.disabled = false;
      restartBtn.textContent = "Restart";
      return;
    }
    renderList();
    return;
  }
  const act = e.target.closest(".act");
  if (act) {
    const id = act.dataset.id;
    if (act.dataset.act === "cancel") await cancelDownload(id);
    else if (act.dataset.act === "pause") await pauseDownload(id);
    else if (act.dataset.act === "resume") await resumeDownload(id);
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
els.list.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.classList.contains("restart-input")) return;
  e.preventDefault();
  e.target.closest(".restart-row").querySelector(".restart-btn").click();
});

// Managed download box — paste a URL, start it as a normal chrome.downloads
// item (filename left unset so it keeps whatever name the server provides).
async function submitNewDownload() {
  const url = els.newUrl.value.trim();
  if (!url) { els.newUrl.focus(); return; }
  els.startDownload.disabled = true;
  const result = await startDownload(url);
  els.startDownload.disabled = false;
  if (!result.ok) {
    els.newUrl.value = "";
    els.newUrl.placeholder = "Couldn't start — check the URL";
    return;
  }
  els.newUrl.value = "";
  els.newUrl.placeholder = "Paste a URL to download…";
  renderList();
}
els.startDownload.addEventListener("click", submitNewDownload);
els.newUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") submitNewDownload(); });

// Bulk actions — operate on exactly the rows currently in view.
const CLEAR_CONFIRM_THRESHOLD = 5; // ask before wiping more than this many rows at once

els.cancelAll.addEventListener("click", async () => {
  const running = currentItems.filter(isRunning);
  await Promise.all(running.map((it) => cancelDownload(it.id)));
  renderList();
});
els.clearAll.addEventListener("click", async () => {
  const stopped = currentItems.filter((it) => !isRunning(it));
  if (stopped.length > CLEAR_CONFIRM_THRESHOLD &&
      !confirm(`Clear ${stopped.length} downloads from the list?`)) {
    return;
  }
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

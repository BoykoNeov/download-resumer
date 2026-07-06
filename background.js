// Download Resumer — background service worker
// Watches downloads. When one is interrupted but resumable, it retries with a
// short backoff, resuming the SAME download item so Chrome keeps the original
// filename and continues from the bytes already on disk (range request).
// It also records a timestamped event log per download so the popup can show
// exactly when hiccups happened, the error reason, and the retry history.

const DEFAULTS = {
  enabled: true,
  maxRetries: 1000,        // consecutive stalled failures before giving up
  retryDelaySec: 5,        // base delay before the first resume attempt
  maxRetryDelaySec: 300,   // cap for the exponential backoff below
  notify: true,
};

const RETRY_KEY = "retryState";   // { [id]: { count, lastBytes, nextAt, pending } }
const EVENT_KEY = "eventLog";     // { [id]: [ { t, type, error?, bytes?, attempt? } ] }
const MAX_EVENTS = 120;           // per download
const SWEEP_ALARM = "resume-sweep";

// ---------- config / retry storage ----------
async function getConfig() {
  const stored = await chrome.storage.local.get("config");
  return { ...DEFAULTS, ...(stored.config || {}) };
}
async function getRetryState() {
  const stored = await chrome.storage.local.get(RETRY_KEY);
  return stored[RETRY_KEY] || {};
}
async function setRetryState(state) {
  await chrome.storage.local.set({ [RETRY_KEY]: state });
}

// All retryState reads+writes go through this one chain so concurrent
// handleInterruption() calls for different ids (e.g. a flaky connection
// dropping several downloads at once) can't lost-update each other's
// pending/nextAt via a stale read of the shared map.
let retryChain = Promise.resolve();
function mutateRetryState(fn) {
  const p = retryChain.then(async () => {
    const state = await getRetryState();
    const result = await fn(state);
    await setRetryState(state);
    return result;
  });
  retryChain = p.catch(() => {});
  return p;
}

function clearRetry(id) {
  return mutateRetryState((state) => { delete state[id]; });
}

// Clears the pending/nextAt schedule once a download is actually moving
// again, so a stale "already scheduled" guard can't block its next hiccup.
function markResumed(id) {
  return mutateRetryState((state) => {
    const entry = state[id];
    if (entry) { entry.pending = false; entry.nextAt = 0; }
  });
}

// ---------- event log (serialized writes to avoid clobbering) ----------
let writeChain = Promise.resolve();

function appendEvent(id, ev) {
  writeChain = writeChain.then(async () => {
    const store = await chrome.storage.local.get(EVENT_KEY);
    const log = store[EVENT_KEY] || {};
    const arr = log[id] || [];
    arr.push({ t: Date.now(), ...ev });
    if (arr.length > MAX_EVENTS) arr.splice(0, arr.length - MAX_EVENTS);
    log[id] = arr;
    await chrome.storage.local.set({ [EVENT_KEY]: log });
  }).catch(() => {});
  return writeChain;
}

// Only log a "resumed" event if the download was actually in a stalled state.
function appendRecovered(id, bytes) {
  writeChain = writeChain.then(async () => {
    const store = await chrome.storage.local.get(EVENT_KEY);
    const log = store[EVENT_KEY] || {};
    const arr = log[id] || [];
    const last = arr[arr.length - 1];
    if (last && (last.type === "hiccup" || last.type === "retry")) {
      arr.push({ t: Date.now(), type: "recovered", bytes });
      if (arr.length > MAX_EVENTS) arr.splice(0, arr.length - MAX_EVENTS);
      log[id] = arr;
      await chrome.storage.local.set({ [EVENT_KEY]: log });
    }
  }).catch(() => {});
}

async function pruneLogs() {
  const store = await chrome.storage.local.get(EVENT_KEY);
  const log = store[EVENT_KEY];
  if (!log) return;
  const recent = await chrome.downloads.search({ limit: 100, orderBy: ["-startTime"] });
  const keep = new Set(recent.map((i) => String(i.id)));
  let changed = false;
  for (const id of Object.keys(log)) {
    if (!keep.has(String(id))) { delete log[id]; changed = true; }
  }
  if (changed) await chrome.storage.local.set({ [EVENT_KEY]: log });
}

// ---------- helpers ----------
function baseName(item) {
  if (!item || !item.filename) return "download";
  return item.filename.split(/[\\/]/).pop();
}
function notify(id, title, message) {
  getConfig().then((cfg) => {
    if (!cfg.notify) return;
    chrome.notifications.create(`dr-${id}-${Date.now()}`, {
      type: "basic", iconUrl: "icons/icon48.png", title, message,
    });
  });
}

// ---------- core: handle an interrupted download ----------
async function handleInterruption(id) {
  const cfg = await getConfig();
  if (!cfg.enabled) return;

  const results = await chrome.downloads.search({ id });
  const item = results && results[0];
  if (!item || item.state !== "interrupted") return;

  // A user-canceled download must stay canceled — never auto-resume it.
  if (item.error === "USER_CANCELED") { await clearRetry(id); return; }

  if (!item.canResume) {
    await clearRetry(id);
    appendEvent(id, { type: "stopped", error: item.error || "unknown", bytes: item.bytesReceived });
    notify(id, "Can't auto-resume",
      `${baseName(item)} stopped and can't be resumed (${item.error || "unknown"}).`);
    return;
  }

  const outcome = await mutateRetryState((state) => {
    const entry = state[id] || { count: 0, lastBytes: 0, nextAt: 0, pending: false };

    // A resume is already scheduled and not yet due — leave it alone. This is
    // what stops the 1/min sweep from re-triggering a resume every cycle
    // regardless of the backoff delay (and the duplicate-resume calls that
    // caused).
    if (entry.pending && Date.now() < entry.nextAt) {
      state[id] = entry;
      return { action: "wait" };
    }

    // If bytes advanced since last attempt, we're making progress through the
    // drops — reset the counter so we keep going indefinitely.
    if (item.bytesReceived > entry.lastBytes) {
      entry.count = 0;
      entry.lastBytes = item.bytesReceived;
    }

    if (entry.count >= cfg.maxRetries) {
      delete state[id];
      return { action: "gave_up" };
    }

    entry.count += 1;
    // Exponential backoff: doubles per consecutive stalled attempt, capped so
    // a long-stalled download doesn't end up waiting absurdly long between
    // tries. ±20% jitter on top so a connection drop that takes out several
    // downloads at once doesn't resume them all in the same instant.
    const uncappedMs = Math.max(1, cfg.retryDelaySec) * 1000 * Math.pow(2, entry.count - 1);
    const baseDelayMs = Math.min(uncappedMs, Math.max(1, cfg.maxRetryDelaySec) * 1000);
    const jitterMs = Math.floor(baseDelayMs * 0.2 * (Math.random() * 2 - 1));
    const delayMs = Math.max(1000, baseDelayMs + jitterMs);
    entry.pending = true;
    entry.nextAt = Date.now() + delayMs;
    state[id] = entry;
    return { action: "retry", attempt: entry.count, delayMs };
  });

  if (outcome.action === "wait") return;

  if (outcome.action === "gave_up") {
    appendEvent(id, { type: "gave_up", bytes: item.bytesReceived });
    notify(id, "Gave up", `${baseName(item)} failed ${cfg.maxRetries} times with no progress.`);
    return;
  }

  appendEvent(id, { type: "retry", attempt: outcome.attempt, bytes: item.bytesReceived });
  setTimeout(() => {
    chrome.downloads.resume(id, () => { void chrome.runtime.lastError; });
  }, outcome.delayMs);
}

// ---------- listeners ----------
chrome.downloads.onCreated.addListener((item) => {
  mutateRetryState((state) => {
    state[item.id] = { count: 0, lastBytes: item.bytesReceived || 0, nextAt: 0, pending: false };
  });
  appendEvent(item.id, { type: "created", bytes: item.bytesReceived || 0 });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const s = delta.state.current;

  if (s === "interrupted") {
    chrome.downloads.search({ id: delta.id }, (r) => {
      const it = r && r[0];
      const err = it ? it.error : (delta.error && delta.error.current) || null;
      if (err === "USER_CANCELED") {
        appendEvent(delta.id, { type: "canceled", bytes: it ? it.bytesReceived : 0 });
        clearRetry(delta.id);
        return;
      }
      appendEvent(delta.id, { type: "hiccup", error: err, bytes: it ? it.bytesReceived : 0 });
      handleInterruption(delta.id);
    });
  } else if (s === "in_progress") {
    chrome.downloads.search({ id: delta.id }, (r) => {
      const it = r && r[0];
      appendRecovered(delta.id, it ? it.bytesReceived : 0);
      markResumed(delta.id);
    });
  } else if (s === "complete") {
    clearRetry(delta.id);
    chrome.downloads.search({ id: delta.id }, (r) => {
      const it = r && r[0];
      appendEvent(delta.id, { type: "complete", bytes: it ? it.bytesReceived : 0 });
      if (it) notify(delta.id, "Download complete", baseName(it));
    });
  }
});

// Safety net + housekeeping, once a minute.
chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SWEEP_ALARM) return;
  const cfg = await getConfig();
  if (cfg.enabled) {
    const items = await chrome.downloads.search({ state: "interrupted" });
    for (const item of items) if (item.canResume) handleInterruption(item.id);
  }
  pruneLogs();
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get("config");
  if (!stored.config) await chrome.storage.local.set({ config: DEFAULTS });
});

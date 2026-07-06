# Roadmap

Planned work for Download Resumer, in priority order. Each item lists the intent,
the concrete changes (files + data model), and any assumptions to confirm.

Guiding constraint: **vanilla JS, no build, no dependencies.** Anything that must
outlive the popup or the service worker lives in `chrome.storage.local`.

---

## 1. Exponential backoff + jitter (+ jitter control, "restart backoff", "retry now")

**Why.** The retry delay is currently flat (`retryDelaySec`), and with the
default cap effectively "infinite" (`maxRetries: 1000`) a rate-limiting server
gets hammered every few seconds forever. Exponential backoff with jitter is
gentler and more likely to recover; per-download manual overrides let the user
force progress when they know the connection is back.

### 1a. Idempotent scheduling — the prerequisite (do this first)

> This is not optional. Today the 1/min sweep (`chrome.alarms`) calls
> `handleInterruption()` on **every** interrupted item **every tick**, each time
> incrementing `count` and scheduling a fresh `resume()`. If backoff is layered
> on top unchanged, the sweep **defeats it**: it resumes every ~60s regardless
> of the computed delay, and escalates the backoff level per sweep tick instead
> of per real failure.

Make retry scheduling idempotent by persisting *when* the next resume is due:

- Extend the `retryState` entry (keyed by download id):
  ```jsonc
  { "count": <consecutive stalls>, "lastBytes": <number>,
    "nextAt": <epochMs when the next resume is due>,
    "pending": <bool: a resume is scheduled/awaited> }
  ```
- `handleInterruption()` computes `nextAt = now + delay`, stores it, sets
  `pending = true`, and schedules the `setTimeout`.
- **Both** the `setTimeout` callback **and** the sweep only call `resume()` when
  `Date.now() >= nextAt`. The sweep skips items whose `nextAt` is still in the
  future, and skips scheduling a second timer when `pending` is already set for a
  not-yet-due item.
- Clear `pending` / `nextAt` when the item transitions to `in_progress`,
  `complete`, or is cleared.

Side benefits: this fixes the pre-existing **duplicate-resume bug** (sweep +
setTimeout both firing) for free, and gives the popup a `nextAt` to render a
live **"retrying in Ns"** countdown — which is what makes "Retry now" meaningful.

### 1b. Backoff formula + jitter control

In `handleInterruption()`, replace the flat `delayMs` with:

```js
const level = entry.count;                       // ties backoff to the stall counter
const base  = Math.max(1, cfg.retryDelaySec);
let   delay = cfg.backoff
              ? base * Math.pow(2, Math.min(level, BACKOFF_LEVEL_CAP))
              : base;
delay = Math.min(delay, cfg.maxBackoffSec);      // cap the escalation
const j = cfg.jitterPct / 100;                   // the user-facing "jitter scale"
delay = delay * (1 + j * (Math.random() * 2 - 1)); // symmetric ±jitter
const delayMs = Math.max(1000, Math.round(delay * 1000));
```

- **Symmetric jitter** (±`jitterPct`) is chosen deliberately over full/AWS jitter
  because the request is for a *scale control* the user dials.
- Tying `level` to the existing `count` means the **progress-based reset** (bytes
  advanced → `count = 0`) also resets the backoff escalation naturally.

New `config` keys (with defaults), added to `DEFAULTS` in `background.js` and
`popup.js`:
```jsonc
{ "backoff": true, "maxBackoffSec": 300, "jitterPct": 20 }
```

**UI (popup.html + popup.js):** add to the settings block —
- a **"Jitter"** control (0–100%) — a range slider or number field; wire it to
  `saveConfig()` like the existing fields.
- optionally a **"Backoff"** on/off checkbox and a **"Max wait (sec)"** number
  field for `maxBackoffSec`. (If we want to keep the panel minimal, ship just the
  jitter control + backoff toggle and leave `maxBackoffSec` at its default.)

### 1c. Per-download manual overrides

Add two buttons to each download's **detail panel** (`renderDetail()`), shown
only for interrupted-but-resumable rows:

- **Retry now** — resume immediately, skipping the remaining wait. The popup
  calls `chrome.downloads.resume(id)` directly (consistent with how it already
  does cancel/erase), and resets the backoff level so subsequent auto-retries
  start from base. **A manual retry does NOT count against `maxRetries`** — it's
  an override, so reset `count` (and clear `nextAt`/`pending`) in `retryState`.
- **Restart backoff** ("restart the jitter") — reset the backoff level to base
  **without** resuming now. The next *natural* auto-retry then starts at the base
  delay. Implemented as a `retryState` write (`count = 0`, recompute/clear
  `nextAt`). This is the sibling of "Retry now" minus the immediate resume.

> **Assumptions to confirm** (both are corrigible on review):
> - "Retry now" = resume immediately + reset backoff level, not counted against
>   the give-up cap.
> - "Restart the jitter" = reset backoff level to base, no immediate resume.
> If "restart backoff" was meant to be a single **global** button (reset every
> active download) rather than per-download, that's a one-line variant.

Wire both via event delegation on `#list` (same pattern as the existing
`.act` cancel/clear handlers). Log a `retry` event with an `attempt`/manual flag
so the history shows the user forced it.

---

## 2. Notification click-through (+ notifications on/off)

**Note:** the on/off toggle **already exists** — `#notify` in popup.html
("Show a notification when a download finishes or fails"), persisted in `config`.
No new work needed there; it stays. The new work is purely the click handler.

**Why.** Completion/failure toasts currently do nothing when clicked.

**Change (`background.js`):** add
```js
chrome.notifications.onClicked.addListener((notifId) => {
  // notifId is `dr-${id}-${ts}` — parse the download id
  const id = Number(notifId.split("-")[1]);
  if (Number.isInteger(id)) chrome.downloads.show(id);   // opens the file's folder
  else chrome.tabs.create({ url: "chrome://downloads" });
  chrome.notifications.clear(notifId);
});
```
- `chrome.downloads.show(id)` opens the containing folder for a finished file;
  fall back to opening `chrome://downloads` when the id can't be resolved.
- `tabs` is available without an extra permission for `chrome://downloads`; if a
  strict reviewer flags it, opening the downloads shelf via `downloads.show` is
  enough and needs no `tabs` permission. Prefer `downloads.show` first.

Optional refinement (defer unless wanted): split `notify` into
finish/fail sub-toggles.

---

## Smaller items

Roughly in descending value / ascending effort.

### 3. Toolbar badge
At-a-glance status without opening the popup. In `background.js`, maintain
`chrome.action.setBadgeText` / `setBadgeBackgroundColor` from the `onChanged`
handlers and the sweep:
- count of interrupted/retrying downloads → badge number in `--wait` amber;
- clear the badge when nothing is active. Reuse the semantic colors.

### 4. Copy log button
Per download, a **Copy** button in the detail panel that serializes that id's
`eventLog` to plain text (timestamp · type · error/bytes) for bug reports. The
data is already structured; this is formatting + `navigator.clipboard.writeText`.

### 5. Extract + unit-test the retry decision logic
Refactor the decision inside `handleInterruption()` into a **pure function**
`decideAction(item, entry, cfg)` → `{ action: "resume"|"give_up"|"stop"|"skip",
delayMs?, nextEntry }`. Then add `node:test` tests (built-in, keeps the
zero-dependency rule) covering: user-canceled never resumes, `!canResume` stops,
progress resets the counter, cap → gives up, backoff/jitter bounds. Also unit
-test the pure formatters (`fmtBytes`, `fmtDuration`, `statusFor`). Add a minimal
`package.json` with a `test` script; no runtime deps.

### 6. Speed sparkline
A tiny inline-SVG sparkline in the detail panel from the `samples` window
already collected in `popup.js`. Pure rendering, no new data.

### 7. Confirm on "Clear all"
When "Clear all" would remove several rows, show a lightweight in-popup confirm
(not `window.confirm`, which is discouraged in extension popups) before erasing.

### 8. Light-mode support
`popup.html` is currently dark-only (hard-coded CSS variables). Add a
`prefers-color-scheme: light` block overriding the `:root` variables so the popup
matches the OS theme. Colors are already centralized as variables, so this is
localized to the `<style>` block.

### 9. "Start a managed download" box
A small input in the popup: paste a URL → `chrome.downloads.download({ url })`
(leave filename unset to keep the server name). The download then benefits from
auto-resume like any other.

### 10. Fresh-URL resume for expiring signed URLs (hardest; defer)
When a resume fails on a tokenized/signed URL whose token expired mid-download,
re-fetch a fresh link and continue. Requires host permissions and page/API
scraping specific to the source — significant scope. Track as a stretch goal.

---

## Notes on ordering

- **1a (idempotent scheduling) must land before 1b/1c** — backoff is meaningless
  while the sweep can resume every minute.
- **5 (extract + test)** pairs naturally with **1**: extracting `decideAction`
  makes the backoff logic testable as it's written, rather than retrofitting
  tests later.
- Items **3, 4, 6, 7, 8** are independent and can ship in any order.

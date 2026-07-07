# CLAUDE.md

Guidance for working on this repo with Claude Code.

## What this is

**Download Resumer** — a Manifest V3 Chrome extension that automatically resumes
interrupted downloads instead of letting them restart from zero, and shows a
live per-download panel (speed, ETA, and a timestamped hiccup/retry timeline).
It also lets you pause/resume or cancel running downloads and clear stopped ones,
individually
or in bulk.

The original problem it solves: large downloads (~10 GB) over flaky connections
would drop and restart from the beginning. This hooks Chrome's own download
engine and issues `chrome.downloads.resume()`, which continues the *same*
download item via an HTTP range request — so the partial file and the original
filename are both preserved.

## Loading & testing

There is no build step. It's plain JS/HTML/CSS loaded unpacked.

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. After editing any file, click the **↻ reload** icon on the extension card.
   - Editing `background.js` → reload the extension.
   - Editing `popup.html` / `popup.js` → just reopen the popup (reload still
     safest).
4. Debugging:
   - Popup: right-click the popup → **Inspect**.
   - Service worker: on the extension card, click **service worker** to open its
     DevTools. Note it is terminated when idle (see gotchas).

To exercise resume/cancel logic without a truly flaky link, start any large
download and toggle your network off/on, or use DevTools Network throttling.

## File structure

```
manifest.json     MV3 manifest. Permissions: downloads, downloads.open, storage, alarms, notifications.
background.js     Service worker. All resume logic + event logging live here.
popup.html        Popup markup + all CSS (inline <style>). ~360px wide.
popup.js          Popup rendering, live stats, and the cancel/clear actions.
icons/            16/48/128 px PNGs (generated; see "Regenerating icons").
```

There is no framework and no bundler. Keep it dependency-free.

## Architecture

Two independent contexts that communicate only through `chrome.storage.local`:

- **background.js** (service worker) owns the truth: it listens to download
  events, decides when to resume, and writes the event log + retry state to
  storage. It never talks to the popup directly.
- **popup.js** is a read-mostly view: every second it reads the downloads list
  (`chrome.downloads.search`) and the event log (from storage) and re-renders.
  Its only writes are user actions (cancel/clear/settings), done straight
  through the `chrome.downloads` API and `chrome.storage`.

This separation matters: the popup is usually closed, so nothing important can
live only in popup state.

## Chrome APIs used

- `chrome.downloads.onCreated` / `onChanged` — lifecycle events. **`onChanged`
  does NOT fire on `bytesReceived` or `estimatedEndTime` changes** — only on
  state and other property changes. That's why the popup computes its own speed
  by polling `search()` every second rather than listening for byte updates.
- `chrome.downloads.search()` — read current items. Used by the popup and the
  sweep alarm.
- `chrome.downloads.resume(id)` — the core mechanism. Only works when the item's
  `state === "interrupted"` and `canResume === true`.
- `chrome.downloads.cancel(id)` — used by the Cancel action. Produces an
  interrupted item with `error === "USER_CANCELED"`.
- `chrome.downloads.erase({id})` — used by Clear. Removes the record from
  Chrome's history (does NOT delete the file on disk; that would be
  `removeFile`, which we intentionally don't use).
- `chrome.alarms` — a 1/min "sweep" that re-checks interrupted-but-resumable
  downloads and prunes orphaned logs. This is the safety net for when the
  service worker was killed and an in-flight `setTimeout` was lost.
- `chrome.notifications` — completion / failure toasts.
- `chrome.storage.local` — all persisted state (see data model).

## Data model (`chrome.storage.local`)

Three keys:

```jsonc
// "config"
{ "enabled": true, "maxRetries": 1000, "retryDelaySec": 5, "maxRetryDelaySec": 300, "notify": true }

// "retryState" — keyed by download id (string)
{ "<id>": { "count": <consecutive stalled failures>, "lastBytes": <number>,
            "nextAt": <epochMs a scheduled resume is due>, "pending": <bool> } }

// "eventLog" — keyed by download id (string), each an array capped at 120
{ "<id>": [ { "t": <epochMs>, "type": "<type>", "error"?, "bytes"?, "attempt"? } ] }
```

Event `type` values and their meaning:

| type        | when                                                        |
|-------------|-------------------------------------------------------------|
| `created`   | download started                                            |
| `hiccup`    | interrupted by a (non-user) error; carries `error` + `bytes`|
| `retry`     | a resume attempt was scheduled; carries `attempt` number    |
| `recovered` | transitioned back to `in_progress` after a hiccup/retry     |
| `complete`  | finished                                                     |
| `canceled`  | user canceled (`USER_CANCELED`)                             |
| `stopped`   | interrupted and `canResume === false`                       |
| `gave_up`   | hit `maxRetries` with no forward progress                   |

## Core resume logic (background.js)

`handleInterruption(id)` is the heart of it. Called from the `onChanged`
interrupted handler and from the sweep alarm. It:

1. Bails if disabled, if the item isn't interrupted, or if `error ===
   "USER_CANCELED"` (a canceled download must never auto-resume).
2. If `!canResume` → logs `stopped`, notifies, and stops (nothing can resume a
   server that refused a range request).
3. **Progress-based reset:** if `bytesReceived` advanced since the last attempt,
   resets `count` to 0. This is deliberate — a download that keeps inching
   forward through many drops should retry indefinitely; the `maxRetries` cap
   only counts *consecutive stalls with no progress*.
4. **Idempotent scheduling:** if `pending` is true and `Date.now() < nextAt`, a
   resume is already scheduled and not yet due — bail without touching
   `count` or state. This is what stops the 1/min sweep from re-triggering a
   resume every cycle regardless of the backoff delay (the earlier duplicate-
   resume bug). `nextAt`/`pending` are cleared on recovery (`onChanged` →
   `in_progress`), so a genuinely new hiccup after a brief recovery is never
   blocked by a stale schedule.
5. If `count >= maxRetries` → logs `gave_up`, notifies, stops.
6. Otherwise increments `count`, sets `pending`/`nextAt`, logs `retry`, and
   schedules `chrome.downloads.resume(id)` after an exponential delay:
   `retryDelaySec * 2^(count-1)`, capped at `maxRetryDelaySec`, ± 20% jitter
   (so several downloads dropped by the same network hiccup don't all resume
   in the same instant, and a long-stalled download doesn't end up waiting
   absurdly long between tries).

All `retryState` reads+writes (from `handleInterruption`, `onCreated`,
`clearRetry`, and recovery) are serialized through a single promise chain
(`retryChain`, mirroring `writeChain` for the event log) — otherwise two
downloads dropping at the same instant would read-modify-write the shared
`retryState` map concurrently and lose each other's `pending`/`nextAt`.

Event logging split: the `hiccup` event is logged once per transition in the
`onChanged` listener (not inside `handleInterruption`), so the sweep re-calling
`handleInterruption` doesn't double-log hiccups. `retry` is logged inside
`handleInterruption`.

Log writes go through a `writeChain` promise so rapid drop→retry→resume
sequences don't clobber each other via read-modify-write races.

## Popup rendering model (popup.js)

- Re-renders the whole list every 1000ms (`setInterval`). Cheap; the list is
  small. `els.list.scrollTop` is saved/restored around the innerHTML rebuild.
- **Expanded state** lives in an in-memory `Set` of id strings (`expanded`), so
  it survives the re-render. Toggled via event delegation on `#list`.
- **Speed** is computed from a rolling window of `{t, bytes}` samples per id
  (`samples`), kept to the last 8 samples (~8s). ETA = remaining / speed, with
  `estimatedEndTime` as a fallback.
- **Speed sparkline** in the detail panel reads a separate `speedHistory`
  array per id (last `SPARK_LEN` = 30 samples, ~30s), rendered as an inline
  SVG polyline. Only shown while the download is actively running; both
  `samples` and `speedHistory` for an id are dropped the moment it stops being
  active, so a stalled/finished row doesn't carry stale history into its next
  run.
- **Next retry countdown**: the detail panel's stats grid reads `retryState`
  (fetched alongside `eventLog` in `renderList`) and, while an interrupted item
  has a pending scheduled resume, shows a live "Next retry" stat counting down
  to `retryState[id].nextAt`. This is the *actual* backed-off delay for that
  specific download (which grows with each consecutive stalled attempt), not
  the "Wait between retries" setting — that setting is the shared base delay
  across all downloads, so it deliberately isn't overwritten to reflect any
  one download's current backoff.
- **Copy log** button in the detail panel dumps that download's `eventLog` (via
  `buildLogText`) to the clipboard with `navigator.clipboard.writeText`, for
  pasting into bug reports. Button label flips to "Copied!"/"Copy failed" for
  ~1.2s as feedback.
- **Bulk actions are WYSIWYG:** `currentItems` holds exactly the rows currently
  shown, and Cancel all / Clear all operate on that set (running vs. stopped).
  Counts and disabled state come from `updateToolbar()`. Clear all asks for
  confirmation first if it would remove more than `CLEAR_CONFIRM_THRESHOLD`
  (5) rows, to guard against an accidental bulk wipe. Clear all is the *only*
  bulk-clear action — there used to be a separate "Clear all history" button
  that reached Chrome's entire download history beyond what the popup
  displayed; it was removed because the popup doesn't present itself as a
  history viewer, so clearing history from it was surprising. If a
  `<label for="X">` is ever added back next to a button in `.settings`, note
  that a label pointing at a button (a labelable element) fires a synthetic
  click on it from anywhere in the label text, not just the button itself.
- Per-row button is contextual: running rows show **Pause/Resume** (toggles on
  `item.paused`) plus **Cancel** (stop icon), stopped rows show **Clear** (trash
  icon). Clearing also purges that id's `eventLog` / `retryState` entries.
- **Pause/Resume** (`pauseDownload`/`resumeDownload`) call
  `chrome.downloads.pause`/`resume` directly and are orthogonal to the
  auto-resume logic in `background.js`: pausing keeps `state === "in_progress"`
  and only flips `paused`, so `onChanged`'s `if (!delta.state) return;` guard
  means it never touches `retryState`/the interrupted-handling path.
  `chrome.downloads.resume()` is the same call background.js uses to resume an
  interrupted download — Chrome overloads it for both "continue a paused
  download" and "continue an interrupted one."
- **Open file / Show in folder**: a `complete` row's detail panel
  (`renderFileActions`) gets two buttons calling `chrome.downloads.open(id)` /
  `.show(id)`. `open()` requires the `downloads.open` manifest permission (on
  top of `downloads`) and must run synchronously off the click — no `await`
  before it — since Chrome requires an active user gesture and throws outside
  one.
- **Managed download box** (`#newUrl` / `#startDownload`, above the list): paste
  a URL and it calls `chrome.downloads.download({ url })` directly — filename
  is left unset so it keeps whatever name the server provides. Lives outside
  `#list`, so the 1s re-render never touches it.
- **Restart with new URL**: any `interrupted` row's detail panel gets a
  `.restart-input` + Restart button (`renderRestart`). Since Chrome's own
  `resume()` can't be redirected to a different URL and keep the partial file
  (see the DNR gotcha below), this is a full re-download under the new URL via
  `startDownload()`, followed by erasing the old dead entry
  (`restartWithNewUrl`) — a restart, not a resume.
- **Expired-URL hint**: `renderRestart` also calls `looksLikeExpiredUrl(item)`,
  a heuristic (`SERVER_FORBIDDEN`/`SERVER_UNAUTHORIZED` + a signed-URL-shaped
  query param like `Signature=`/`X-Amz-Expires=`/`token=`) that shows a hedged
  "may have expired" banner above the restart input. It's presentation-only —
  no new storage, no background changes — and worded as a possibility, not a
  certainty, since Chrome never actually tells us a token expired.
- Because `.restart-input` lives inside `#list`, the 1s re-render would wipe
  focus and whatever the user just typed mid-keystroke — `renderList()` bails
  out for the tick entirely while `document.activeElement` is a
  `.restart-input`, at the cost of every other row's progress freezing for
  those few seconds.

The popup list shows every `in_progress`, `interrupted`, or `complete` item
`chrome.downloads.search` returns (limit 50, newest-started first) — no
time-based decay. Active (`in_progress`) rows are sorted to the top; the rest
keep search's newest-first order below. A completed or interrupted download
stays listed until it's cleared, individually or via Clear all — that's
deliberate, since Clear all history was removed (see the popup rendering
model section) and Clear all is now the only way to tidy up the list.

## MV3 gotchas (read before debugging "it didn't resume")

- **Service worker lifecycle:** the worker is killed after ~30s idle. A pending
  `setTimeout` can be lost if the worker dies first. The 1/min sweep alarm is
  the backstop — that's why it exists. Don't move critical retry logic to rely
  solely on `setTimeout`.
- **`onChanged` byte updates:** as noted, it does not fire on `bytesReceived`.
  Don't try to drive progress UI from `onChanged`.
- **Alarms minimum period:** Chrome clamps `periodInMinutes` to a 30s floor for
  released extensions. Don't rely on sub-minute sweeps.
- **No `localStorage`:** service workers can't use it, and it's discouraged in
  extensions generally. Use `chrome.storage.local` (already the case here).
- **`canResume` is the gate, not the error string.** Some servers won't honor
  range requests (`SERVER_NO_RANGE`) → `canResume` is false → we can't help;
  the curl fallback with a fresh URL is the answer there.
- **`declarativeNetRequest` cannot redirect a `resume()` request.** Confirmed
  empirically (Playwright + a local test server, redirect rule with all 15
  `ResourceType` values listed): a control `fetch()` to the same URL got
  redirected correctly, but `chrome.downloads.resume()`'s own request still
  hit the server unredirected every time. So there is no way to hand Chrome a
  fresh URL and have it keep writing an existing partial file — "fresh-URL
  resume" is only achievable as a full restart from byte 0 (see the Restart
  action in the popup). Don't re-attempt this approach without new evidence of
  a Chrome API change.

## Known limitations

- Resume uses Chrome's own mechanism, so it can't resume what Chrome can't
  (`canResume === false`). No extension can work around a server that refuses
  range requests.
- History backfill (`backfillHistory` in background.js) only seeds a single
  `created` event for `in_progress`/`interrupted` items missing a log — it
  can't fabricate hiccups/retries that happened before the extension was
  watching, and it doesn't touch old `complete` items (a completed download's
  detail panel will show "No events yet" if it finished before the extension
  ever saw it, even though the popup now lists it).
- Token-expiry case (signed URLs that expire mid-download): resume may fail
  even though `canResume` was true. There's no way to preserve the partial
  file here (see the `declarativeNetRequest` gotcha above) — the **Restart
  with new URL** action in an interrupted row's detail panel is the recovery
  path, and it restarts from byte 0 under the pasted URL. The expired-URL
  hint (see above) is a heuristic nudge toward that action, not proof the
  token actually expired — it can misfire on a plain 401/403 misconfiguration,
  and it will miss expiry on servers that don't use recognizable signed-URL
  query params.

## Dev workflow

### Preview the popup without Chrome
A Playwright harness renders `popup.html` with mock data to a screenshot. Rough
recipe (kept out of the shipped extension):

```bash
pip install playwright --break-system-packages
python3 -m playwright install chromium
# build a preview.html that inlines popup.html's <style> + mock rows,
# then screenshot at viewport width 360.
```

This is only a visual sanity check — it does not exercise the real
`chrome.downloads` APIs. Real behavior must be tested in Chrome.

### Regenerating icons
Icons are generated with Pillow (dark rounded square + green download glyph):

```bash
pip install pillow --break-system-packages
# see the generator snippet in git history; supersample 8x then LANCZOS down
# to 16/48/128 to keep edges crisp.
```

### Packaging
```bash
zip -r download-resumer.zip download-resumer -x "*.DS_Store"
```
For Web Store submission you'd zip the folder contents and fill out store
metadata; that's out of scope for local dev.

### Sanity checks
```bash
node --check background.js
node --check popup.js
python3 -c "import json; json.load(open('manifest.json'))"
```

## TODOs / ideas (not yet implemented)

- Investigated: `chrome.storage.session` for `samples`-like ephemeral data.
  Not applicable today — `samples`/`speedHistory` live only in `popup.js` as
  module globals, recomputed from scratch each time the popup opens (that's
  intentional; there's no requirement to survive a popup close). `background.js`
  has no comparable in-memory ephemeral cache — `retryChain`/`writeChain` are
  just serialization promise chains, not data. Revisit only if ephemeral
  per-download state is ever added to the service worker itself.

## Conventions

- Vanilla JS, no dependencies, no build. Keep it that way unless there's a
  strong reason.
- MV3 CSP forbids inline event handlers (`onclick=`) and inline `<script>`.
  Attach listeners in `popup.js`; inline `<style>` is fine.
- All colors come from CSS variables defined at the top of `popup.html`. Status
  colors are semantic: `--live` (downloading), `--wait` (retrying/paused),
  `--dead` (failed/canceled), `--accent` (complete/controls). Reuse them.
- Persist anything that must outlive the popup or the service worker in
  `chrome.storage.local`, never in module globals.

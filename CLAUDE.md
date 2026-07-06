# CLAUDE.md

Guidance for working on this repo with Claude Code.

## What this is

**Download Resumer** — a Manifest V3 Chrome extension that automatically resumes
interrupted downloads instead of letting them restart from zero, and shows a
live per-download panel (speed, ETA, and a timestamped hiccup/retry timeline).
It also lets you cancel running downloads and clear stopped ones, individually
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
manifest.json     MV3 manifest. Permissions: downloads, storage, alarms, notifications.
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
- **Bulk actions are WYSIWYG:** `currentItems` holds exactly the rows currently
  shown, and Cancel all / Clear all operate on that set (running vs. stopped).
  Counts and disabled state come from `updateToolbar()`.
- Per-row button is contextual: running rows show **Cancel** (stop icon),
  stopped rows show **Clear** (trash icon). Clearing also purges that id's
  `eventLog` / `retryState` entries.

The popup list only shows: everything `in_progress` or `interrupted`, plus
`complete` items finished in the last 2 minutes.

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

## Known limitations

- Resume uses Chrome's own mechanism, so it can't resume what Chrome can't
  (`canResume === false`). No extension can work around a server that refuses
  range requests.
- History only covers events after the extension was installed/running; a
  download already in flight at install time won't have backfilled history.
- Bulk Clear only affects the rows currently visible in the popup (recent /
  active), not the user's entire download history.
- Token-expiry case (signed URLs that expire mid-download) isn't handled — if a
  URL's token expires, resume may fail even though `canResume` was true. A
  future feature could re-fetch a fresh URL. See TODOs.

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

- **Copy log** button per download — dump the hiccup timeline as text for bug
  reports.
- **Speed sparkline** in the detail panel.
- **Fresh-URL resume** for expiring signed URLs: when a resume fails on a
  tokenized URL, re-fetch the page/API to get a new link and continue.
- **Start-a-managed-download** box: paste a URL, call
  `chrome.downloads.download()` (leave filename unset to keep the server name).
- **Confirm dialog** on "Clear all" if it would remove many rows.
- Consider `chrome.storage.session` for `samples`-like ephemeral data if any
  moves to the worker.

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

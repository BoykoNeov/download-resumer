# Download Resumer

A Manifest V3 Chrome extension that **automatically resumes interrupted
downloads** instead of letting them restart from zero — and shows a live,
per-download panel with speed, ETA, and a timestamped hiccup/retry timeline.

Large downloads over flaky connections tend to drop and restart from the
beginning. Download Resumer hooks Chrome's own download engine and issues
`chrome.downloads.resume()`, which continues the **same** download via an HTTP
range request — so the partial file and the original filename are both
preserved.

## Features

- **Automatic resume** of interrupted-but-resumable downloads, with a short
  configurable retry delay.
- **Live panel** per download: speed, ETA, bytes, and an expandable history of
  every hiccup, retry, and recovery with timestamps.
- **Progress-aware retries:** a download that keeps inching forward through many
  drops retries indefinitely; the "give up" cap only counts *consecutive stalls
  with no progress*.
- **Manual controls:** cancel running downloads and clear stopped ones —
  individually or in bulk (bulk actions are WYSIWYG on the visible rows).
- **Notifications** on completion / failure (toggleable).
- **Survives the service-worker lifecycle:** a 1/min sweep alarm re-checks
  interrupted downloads even if the worker was killed mid-wait.

## Install (unpacked)

There is no build step — it's plain JS/HTML/CSS.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. After editing any file, click the **↻ reload** icon on the extension card.

## How it works

Two contexts that communicate only through `chrome.storage.local`:

- **`background.js`** (service worker) owns the truth: it listens to download
  events, decides when to resume, and writes the event log + retry state to
  storage.
- **`popup.js`** is a read-mostly view: every second it reads the downloads list
  and event log and re-renders. Its only writes are user actions.

See [`CLAUDE.md`](CLAUDE.md) for the full architecture notes and MV3 gotchas.

## Permissions

`downloads`, `storage`, `alarms`, `notifications`. No host permissions, no
network requests of its own — all state lives in `chrome.storage.local` on your
machine.

## Limitations

- Resume uses Chrome's own mechanism, so it can't resume what Chrome can't
  (`canResume === false`) — no extension can work around a server that refuses
  range requests.
- History only covers events after the extension was running.
- Signed URLs whose token expires mid-download aren't handled yet (see the
  roadmap).

## Roadmap

Planned work — exponential backoff with a jitter control, manual "retry now" /
"restart backoff", notification click-through, a toolbar badge, and more — is
tracked in [`ROADMAP.md`](ROADMAP.md).

## Development

```bash
# Sanity checks (no build, no deps)
node --check background.js
node --check popup.js
python3 -c "import json; json.load(open('manifest.json'))"

# Package for the Web Store
zip -r download-resumer.zip . -x "*.git*" "*.zip" "ROADMAP.md"
```

Vanilla JS, no dependencies, no bundler. MV3 CSP forbids inline event handlers
and inline `<script>`; attach listeners in `popup.js` (inline `<style>` is fine).

## License

[MIT](LICENSE) © 2026 Boyko Neov

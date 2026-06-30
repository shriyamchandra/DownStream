# DownStream

A desktop download manager for macOS powered by [aria2](https://aria2.github.io/). It wraps `aria2c` in an Electron shell with a local web UI, real-time progress tracking, in-app media streaming, and a Chrome extension that intercepts browser downloads before single-use tokens expire.

![Platform](https://img.shields.io/badge/platform-macOS-blue)
![Electron](https://img.shields.io/badge/electron-42-blue)
![License](https://img.shields.io/badge/license-ISC-green)

---

## Features

- **Multi-protocol downloads** — HTTP, HTTPS, FTP, magnet links, and `.torrent` files via aria2's engine (16 connections per download)
- **Real-time dashboard** — live progress bars, speed graph, pause / resume / cancel / retry per download
- **Stream before complete** — open partially downloaded media in VLC, IINA, or QuickTime once enough has buffered
- **Category folders** — automatic file-type detection organises downloads into subfolders (Video, Audio, Documents, etc.)
- **Chrome extension** — intercepts large file downloads in the browser and sends them to DownStream before the server's download token is consumed
- **Native Messaging** — compiled C bridge between Chrome and the app (no Node.js runtime needed in the host); falls back to `downstream://` custom protocol
- **Dark / light theme** — auto-follows system preference, or manual toggle
- **Speed presets** — one-click global bandwidth limits
- **macOS notifications** — desktop alerts when downloads are captured or completed
- **Portable packaging** — ships as a self-contained `.dmg` with a bundled `aria2c` binary (no Homebrew needed)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Electron Main Process  (backend/main.js)                        │
│    ├── Registers downstream:// custom protocol                   │
│    ├── Installs Native Messaging manifests for Chrome/Brave/Edge │
│    └── Opens BrowserWindow → http://localhost:PORT               │
├──────────────────────────────────────────────────────────────────┤
│  Express Backend  (backend/server.js)                            │
│    ├── REST API  (/api/*)                                        │
│    ├── Static file server for frontend/                          │
│    ├── aria2c process manager (spawn, health check, restart)     │
│    ├── History sync service (aria2 ↔ history.json every 2.5s)    │
│    └── Intercept handler (queues URLs until aria2 is ready)      │
├──────────────────────────────────────────────────────────────────┤
│  aria2c  (RPC on port 6800)                                      │
│    └── Stateless JSON-RPC over HTTP POST                         │
├──────────────────────────────────────────────────────────────────┤
│  Frontend  (frontend/)                                           │
│    ├── Vanilla HTML + modular ES6 JS                             │
│    ├── WebSocket to aria2c for live download events              │
│    ├── Layered CSS (tokens → themes → layout → components)       │
│    └── Event-delegated UI (no inline onclick handlers)           │
├──────────────────────────────────────────────────────────────────┤
│  Chrome Extension  (extension/)                                  │
│    ├── Service worker captures downloads via 3 strategies        │
│    │   (downloads API, navigation intercept, content script)     │
│    ├── Native Messaging → C host → curl → /api/intercept        │
│    └── Fallback: downstream:// protocol launch                   │
├──────────────────────────────────────────────────────────────────┤
│  Native Messaging Host  (native-host/)                           │
│    └── Compiled C binary — reads Chrome stdio, POSTs to Express  │
└──────────────────────────────────────────────────────────────────┘
```

### Data flow: Chrome → DownStream

1. User clicks a download link in Chrome
2. Extension captures the URL, filename, cookies, referrer, and user-agent
3. Sends payload via **Chrome Native Messaging** (stdio → C binary → `curl POST /api/intercept`)
4. If Native Messaging fails, falls back to `downstream://add?url=...&filename=...` custom protocol
5. Express backend calls `aria2.addUri()` via JSON-RPC
6. Frontend picks up the new download on the next sync cycle

---

## Requirements

- **macOS** (tested on 13+)
- **Node.js** 18+ (LTS recommended)
- **aria2c** — bundled at `bin/aria2c` for packaged builds; install via `brew install aria2` for development

---

## Quick Start

### Electron app (recommended)

```bash
npm install
npm start
```

### Web UI only (no Electron shell)

```bash
npm run dev
```

Or with custom ports:

```bash
PORT=3999 ARIA2_PORT=6801 npm run dev
```

Then open `http://localhost:3999` in a browser.

### Build & install the .app bundle

```bash
./update-dmg.sh --install        # Build .dmg and copy to /Applications
./update-dmg.sh --install --run  # Build, install, and launch
```

---

## Chrome Extension Setup

1. Open `chrome://extensions` in Chrome, Brave, or Edge
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` folder
4. The app registers Native Messaging manifests automatically on launch — no manual configuration needed
5. Click the extension popup to enable/disable interception

The extension works with **any port** — the C native host reads the port from `~/Library/Application Support/DownStream/server-info.json` at runtime.

---

## Configuration

Settings are stored in `~/Library/Application Support/DownStream/config.json` (Electron) or `backend/config.json` (dev mode).

```json
{
    "preferredPlayer": "vlc",
    "downloadDir": "/Users/you/Downloads/DownStream"
}
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `WEB_PORT` | `3000` | Express server port |
| `ARIA2_PORT` | `6800` | aria2 JSON-RPC port |

---

## HTTP API

All endpoints are served from the Express server (default `http://localhost:3000`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/ping` | Health check (returns `{ok: true, webPort}`) |
| `GET` | `/api/settings` | Read current settings |
| `POST` | `/api/settings` | Update settings (player, download dir) |
| `GET` | `/api/history` | Full download history |
| `POST` | `/api/history/clear-completed` | Remove all finished entries |
| `POST` | `/api/history/delete` | Delete a download (+ optional file removal) |
| `POST` | `/api/history/retry` | Restart a failed download from scratch |
| `POST` | `/api/stream` | Open a downloaded file in the preferred player |
| `POST` | `/api/delete` | Delete a file from disk |
| `POST` | `/api/showInFinder` | Reveal a file in Finder |
| `POST` | `/api/notify` | Show a macOS desktop notification |
| `POST` | `/api/intercept` | Accept a download URL from the Chrome extension |
| `GET` | `/api/config.js` | Dynamic JS with port + path config for the frontend |

---

## Project Structure

```
downstream/
├── backend/
│   ├── main.js                 # Electron main process (window, protocol, native messaging)
│   ├── server.js               # Express app, composition root, shutdown handler
│   ├── config.js               # Settings loader (config.json, paths, ports)
│   ├── shared-constants.js     # Shared file-type lists, URL parsing (CommonJS copy)
│   ├── aria2/
│   │   ├── processManager.js   # aria2c lifecycle (spawn, restart with backoff, cleanup)
│   │   └── rpcClient.js        # Stateless HTTP JSON-RPC client for aria2
│   ├── history/
│   │   ├── historyStore.js     # Persistent download history (history.json)
│   │   └── syncService.js      # Periodic aria2 ↔ history reconciliation
│   ├── lib/
│   │   ├── pathGuard.js        # Path traversal prevention for file operations
│   │   └── notifier.js         # macOS notification wrapper (osascript)
│   ├── middleware/
│   │   └── httpGuards.js       # CORS and request logging middleware
│   └── routes/
│       ├── settings.js         # GET/POST /api/settings
│       ├── files.js            # /api/stream, /api/delete, /api/showInFinder
│       ├── history.js          # /api/history, clear, delete, retry
│       └── intercept.js        # /api/intercept (Chrome extension endpoint)
├── frontend/
│   ├── index.html              # Single-page app shell
│   ├── style.css               # Import entry point
│   ├── css/
│   │   ├── tokens.css          # Design tokens (colors, spacing, radii)
│   │   ├── themes.css          # Dark/light theme variables
│   │   ├── reset.css           # CSS reset
│   │   ├── layout.css          # Page layout and grid
│   │   ├── utilities.css       # Utility classes
│   │   ├── responsive.css      # Breakpoint overrides
│   │   └── components/         # Component-scoped styles
│   └── js/
│       ├── main.js             # App entry, polling loop, WebSocket setup
│       ├── api.js              # HTTP API wrapper functions
│       ├── downloads.js        # Download actions (add, pause, resume, cancel)
│       ├── events.js           # Event delegation on the download list
│       ├── render.js           # DOM rendering for download items
│       ├── format.js           # Number/byte/time formatting helpers
│       ├── speedGraph.js       # Canvas-based speed history graph
│       ├── state.js            # Reactive UI state store
│       ├── theme.js            # Theme toggle logic
│       ├── transport.js        # WebSocket connection manager
│       ├── env.js              # Runtime environment detection
│       └── shared-constants.js # File-type lists, URL parsing (ES module copy)
├── extension/
│   ├── manifest.json           # Chrome extension manifest (MV3, locked extension ID)
│   ├── background.js           # Service worker: download interception logic
│   ├── content.js              # Content script: click-based link capture
│   ├── popup.html              # Extension popup UI (enable/disable toggle)
│   ├── popup.js                # Popup logic
│   └── shared-constants.js     # File-type lists (synced copy)
├── native-host/
│   ├── interceptor.c           # C native messaging host (Chrome ↔ curl ↔ Express)
│   ├── interceptor              # Compiled binary (arm64)
│   └── com.downstream.interceptor.json  # Native messaging manifest template
├── shared/
│   └── shared-constants.js     # Canonical source for file-type lists and URL utils
├── scripts/
│   └── sync-shared.js          # Copies shared-constants.js to backend/frontend/extension
├── bin/
│   └── aria2c                  # Bundled aria2c binary for packaged builds
├── build/                      # Electron-builder resources (icons, entitlements)
├── run.sh                      # Dev launcher script (port checking, process management)
├── update-dmg.sh               # Build, package, and optionally install the .app
├── package.json                # npm scripts, electron-builder config, dependencies
└── BUG_REPORT.md               # Issue tracker and fix history
```

### Shared constants

File-type lists (video, audio, document extensions), content-type mappings, and URL-to-filename parsing live in `shared/shared-constants.js`. The `sync-shared.js` script copies this file into `backend/`, `frontend/js/`, and `extension/` — each adapted for its module system (CommonJS or ES modules). This runs automatically on `npm start` and `npm run dev`.

---

## Reliability Features

- **Process management** — tracks `aria2c` PID in `pids.json`; clean SIGTERM → SIGKILL on shutdown
- **Auto-restart with backoff** — if `aria2c` crashes, retries up to 5 times with exponential delay (1s → 2s → 4s → 8s → 16s); stops after 5 consecutive failures
- **Non-blocking port wait** — async polling instead of synchronous `sleep` loops on startup
- **Path traversal guard** — all file operations are validated against the configured download directory
- **Sync guard** — prevents concurrent history sync cycles from racing on the shared array
- **Graceful shutdown** — clears intervals, stops sync, closes HTTP server, kills aria2c, deletes PID file

---

## Codebase Hardening & Refactoring

The codebase has undergone a major engineering iteration focusing on performance, memory footprint, security, and timing resilience:

### Chrome Extension Hardening
- **Zero-Hang Download Timing** — Interception has been deferred to the `chrome.downloads.onChanged` listener (waiting until the `in_progress` state when metadata is resolved). The `onDeterminingFilename` listener now returns immediately, preventing the browser's download manager thread from hanging.
- **Direct Media Stream Interceptor** — Left-clicking video or audio links (MP4, MKV, MP3, etc.) triggers a custom choice modal asking the user to either stream the file directly to their player or download it normally.
- **MutationObserver Lifecycle Optimization** — The content script disconnects the MutationObserver as soon as the Floating Action Button (FAB) is injected. The observer is reconnected only when the FAB is dismissed or when a Single Page Application (SPA) route change occurs, eliminating background CPU overhead.
- **Non-Blocking Confirm Dialogs** — The extension popup uses a custom in-popup overlay dialog rather than the default `confirm()` alert, preventing the extension popup window from losing focus and closing in Chrome.
- **Event Delegation in Popup** — Replaced ad-hoc element queries and listener attachments in the popup's polling loop with body-level event delegation.
- **Service Worker Keepalive** — Implemented an active keepalive loop inside `background.js` during network handshakes and retry polls to guarantee Chrome does not terminate the worker.
- **Memory Leak Safeguards** — Added a periodic cleanup timer to prune stale items from the service worker's `recentlyHandled` cache Map.

### Core & API Protection
- **Port Scanner Parallelization** — Dynamic backend port discovery now queries all ports in parallel with an 800ms timeout threshold, dropping discovery latency from 3.2s to 800ms.
- **Strict CORS Whitelisting** — Restricted request handling in `backend/middleware/httpGuards.js` by explicitly verifying and whitelisting the extension's unique ID block.
- **Information Leak Redactions** — Redacted session cookies from server startup/interceptor logging and masked tracebacks under database write setting failures.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| UI says "cannot connect to aria2c" | Check terminal for startup errors. Try custom ports: `PORT=3999 ARIA2_PORT=6801 npm start` |
| Stream button missing | File must be a recognised video/audio type and partially downloaded. Check preferred player is installed. |
| Extension not intercepting | Open the extension popup and make sure interception is enabled. Check `chrome://extensions` for errors. |
| Notifications not showing | Allow notifications for DownStream in **System Settings → Notifications** |
| Port conflict on restart | The app waits up to 2s for ports to free. If issues persist, use different ports via env vars. |
| Native Messaging errors in Chrome | The app registers manifests automatically. Verify the `interceptor` binary exists and is executable (`chmod +x native-host/interceptor`). |

---

## License

ISC

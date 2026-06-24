# DownStream

DownStream is a desktop download manager built on top of `aria2c` with a local web UI, streaming shortcuts, and an optional Chrome extension that intercepts large downloads. It supports two runtime modes: an Electron app with an embedded Express backend, and a Tauri app that uses native commands for the same API surface.

## Features

- Local web UI for adding URLs, magnet links, and .torrent files
- Real-time download list with pause/resume/cancel/retry
- Stream a file once it has buffered (macOS `open` integration)
- Open downloaded files in Finder
- Global speed limit presets
- User settings for preferred player and download directory
- Chrome extension to intercept browser downloads and send them to the app

## Architecture

### Electron + Express backend

- Electron entrypoint: [main.js](main.js)
- Backend server: [server.js](server.js)
- Frontend assets: [public/index.html](public/index.html) and [public/app.js](public/app.js)

Flow:
1. Electron starts and requires the backend server.
2. Express serves the UI on http://localhost:3000 and spawns `aria2c` on port 6800.
3. The UI talks to `aria2c` via WebSocket JSON-RPC (ws://127.0.0.1:6800/jsonrpc).
4. The Chrome extension sends intercepted downloads to the backend at /api/intercept.

### Tauri backend

- Tauri entrypoint: [src-tauri/src/main.rs](src-tauri/src/main.rs)
- Commands and embedded server: [src-tauri/src/lib.rs](src-tauri/src/lib.rs)
- Tauri config: [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)

Flow:
1. The UI runs inside the Tauri WebView.
2. The frontend detects Tauri and uses `window.__TAURI__` to call native commands.
3. The Tauri app exposes a tiny HTTP server for assets and a command-based API.
4. `aria2c` is not started by Tauri, so it must already be running on port 6800.

### Chrome extension

- Extension source: [extension/manifest.json](extension/manifest.json)
- Background logic: [extension/background.js](extension/background.js)
- Content script: [extension/content.js](extension/content.js)

The extension intercepts downloads and POSTs them to http://localhost:3000/api/intercept. If the app is not running, it opens the custom protocol `downstream://` to launch the Electron app and retries.

## Requirements

- Node.js (LTS recommended)
- `aria2c` available in PATH, or bundled at [bin/aria2c](bin/aria2c)
- macOS is required for native player launching and notifications (uses `open` and `osascript`)

For Tauri builds:
- Rust 1.77+ and the Tauri CLI (`@tauri-apps/cli`)

## Quick start (Electron)

```bash
npm install
npm start
```

This launches Electron, starts the Express backend, and opens the UI.

### Web UI only (no Electron shell)

```bash
npm run dev
```

Then open http://localhost:3000 in a browser.

## Tauri development

```bash
npm install
npx tauri dev
```

Notes:
- `aria2c` must be running separately on port 6800 when using Tauri.
- The Tauri config runs `npm run dev` before launching. If you want a different frontend dev server, update [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json).

### Example `aria2c` command for Tauri

```bash
aria2c --enable-rpc=true --rpc-listen-all=true --rpc-allow-origin-all=true --rpc-listen-port=6800
```

## Chrome extension setup

1. Open Chrome and go to chrome://extensions.
2. Enable Developer mode.
3. Click "Load unpacked" and select the [extension](extension) folder.
4. Make sure the app is running on http://localhost:3000.

## Configuration

The app stores settings in a local `config.json` file:

```json
{
  "preferredPlayer": "vlc",
  "downloadDir": "/Users/you/Downloads/DownStream"
}
```

- In Electron, the config is stored under the Electron user data directory.
- In plain `node server.js` dev mode, it uses the project directory.
- In Tauri, it uses the app config directory.

Session persistence is stored in `aria2.session` alongside the config.

## HTTP API (Electron backend)

All endpoints are served from http://localhost:3000.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/settings | Read current settings |
| POST | /api/settings | Update settings |
| POST | /api/stream | Open a downloaded file in the preferred player |
| POST | /api/delete | Delete a downloaded file (and .aria2 control file) |
| POST | /api/showInFinder | Reveal a file in Finder |
| POST | /api/notify | Show a macOS notification |
| POST | /api/intercept | Accept a Chrome extension intercept and queue the URL |

## Project structure

- [main.js](main.js) Electron main process
- [server.js](server.js) Express backend and `aria2c` lifecycle
- [public](public) Frontend assets
- [extension](extension) Chrome extension for intercepting downloads
- [src-tauri](src-tauri) Tauri app source
- [bin/aria2c](bin/aria2c) Bundled `aria2c` binary (used in packaged builds)

## Troubleshooting

- UI says it cannot connect to `aria2c`: ensure `aria2c` is running and listening on port 6800.
- Streaming fails: the file may not have buffered 200 KB yet, or the preferred player is not installed.
- Extension not intercepting: check the toggle in the extension popup and confirm the app is running.
- macOS notifications do not show: check notification permissions for the app in System Settings.

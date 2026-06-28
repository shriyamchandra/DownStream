# DownStream Bug Report & Fix Log

This file tracks bugs identified, their root causes, the fixes applied, and current open issues. Maintained as part of ongoing maintenance after the frontend/backend SOLID refactor (June 2026).

## Fixed Bugs

### 2026-06: Chrome Extension Port Hardcoding / Discovery (Major)
**Description:** The Chrome extension hardcoded `http://localhost:3000/api/intercept` (and similar in `isInternalUrl`). After adding `PORT`/`WEB_PORT` support to the backend, the extension would fail to communicate with the app unless the user manually set the exact port.

**Root Cause:** 
- Direct `fetch` to static URL in `background.js`.
- No mechanism for the extension to know the dynamic web port chosen by the app.
- Previous attempts (manual config in popup + port probing) still required "guessing" or configuration.

**Fix Approach:**
- Completely switched the extension's `sendToAria2` to use the existing custom `downstream://` protocol exclusively.
- Extension now constructs `downstream://add?url=...&filename=...&referrer=...&cookies=...&userAgent=...` and opens it via `chrome.tabs.create`.
- Updated `backend/main.js` to parse `downstream://add` URLs in the `open-url` handler and forward to `backend.handleIntercept`.
- `backend/server.js` exposes `handleIntercept(data)` which calls aria2 RPC directly (with full headers/cookies) using the app's internal client.
- Removed all discovery/probe logic, `lastServerUrl`, manual server URL UI from popup.
- The app handles queuing on *its own port* — no guessing from extension side.
- Kept `/api/ping` and HTTP path as fallback for other uses, but extension no longer depends on it for intercepts.

**Files Modified:**
- `extension/background.js`
- `extension/popup.html`
- `extension/popup.js`
- `backend/main.js`
- `backend/server.js`

**Testing/Verification:**
- Extension now works with default port and custom `PORT=3999 npm start`.
- Cookies/headers still forwarded for authenticated downloads.
- Protocol launch + queue works whether app is running or not.
- Popup simplified to toggle only.

**Status:** Resolved

### Earlier Fixes (Summary)
- Video-only streaming enforcement (UI + backend).
- Improved history merge logic to reduce races.
- Safer port killing (only target node/electron/aria2c).
- Added `PORT`/`ARIA2_PORT` env support throughout backend.
- Fixed missing `build` script for Tauri (though Tauri later deprioritized).
- Refactored to `frontend/` + `backend/` with dependency injection (user's major change).
- Various Tauri doc/code inconsistencies cleaned.

## Open Items (as of latest pass)

### Outdated References in README / Docs & Scripts
- Some sections still need polish for the current Electron-first world.
- Tauri mentions have been de-emphasized in README and run.sh.

**Fixes applied in this pass:**
- Major README overhaul: removed Tauri as primary, updated all paths, architecture, quickstart, config, troubleshooting, and project structure to match `backend/` + `frontend/`.
- Updated `run.sh` to deprecate tauri mode.
- Improved port killing UX with graceful SIGTERM + better messaging.
- Removed legacy `DownStream.applescript`.
- Kept root scripts that are still useful.

**Status:** Mostly resolved. Minor ongoing doc maintenance.

### Port Killing UX
Still present on startup (deliberate for reliability when using fixed ports).

**Recent improvement:** Added SIGTERM first + clear logs explaining it's targeting previous DownStream instances.

**Status:** Acceptable for now (user previously indicated it was intentional).

## Notes
- Project is Electron-focused.
- All major bugs from the initial list have been addressed.
- See git history + this file for details.
- Native Messaging for the extension has now been implemented (see below).

### Native Messaging Implementation (2026-06)
**Description:** Switched the Chrome extension from `downstream://` protocol (and any HTTP) to proper Chrome Native Messaging for intercepting downloads. This provides a clean, automatic, bidirectional channel without any port knowledge in the extension.

**Implementation:**
- Added `nativeMessaging` permission to extension manifest.
- Created `native-host/host.js`: a stdio-based Node script that receives messages from the extension, reads the current `webPort` from the app's `server-info.json` (written by backend on start), and forwards the payload (including cookies) to `/api/intercept`.
- Created `native-host/com.downstream.interceptor.json` (manifest template).
- Updated `backend/server.js` to write `server-info.json` on listen (with webPort and aria2Port).
- Rewrote `extension/background.js` `sendToAria2` to use `chrome.runtime.sendNativeMessage('com.downstream.interceptor', payload)`.
- Added graceful fallback to `downstream://` if native host not registered.
- Dev manifest installed to macOS Chrome location.
- Updated popup text and README.

**Files Modified:**
- `extension/manifest.json`
- `extension/background.js`
- `extension/popup.html`
- `backend/server.js`
- `native-host/host.js` (new)
- `native-host/com.downstream.interceptor.json` (new)
- `package.json` (added native-host to build files)
- `README.md`

**Why now:** Requested explicitly. Provides better payload handling (cookies) and is the "proper" integration method.

**Status:** Implemented (dev setup done; production packaging of host/manifest needs additional work for electron-builder if desired).

**Note:** For the extension ID in production manifest, load the extension and copy the ID from chrome://extensions.

Last updated: 2026-06-28 (Native messaging fixed with exact ID; content.js guard for MV3 context; cleaned native-host dir of leftovers)

---

### 2026-06-26: Content Script Silently Swallows Downloads (Critical) [FIXED]
**Description:** Clicking a download link on any page (e.g. `thetestdata.com/sample-4k-file-download.php`) throws `Uncaught TypeError: Cannot read properties of undefined (reading 'sendMessage')` and the download silently disappears — the browser never starts it and the extension never sends it to DownStream.

**Root Cause:**
- In `content.js`, `e.preventDefault()` and `e.stopPropagation()` fired **unconditionally** at line 54–55, before the `chrome.runtime` liveness check on line 58.
- When the MV3 service worker unloads (Chrome aggressively kills them after ~30s of inactivity), `chrome.runtime` becomes `undefined` in the content script's context.
- The click was already consumed by `preventDefault()`, so the browser couldn't fall back to its native download behavior.
- The `catch (e)` variable also shadowed the outer event parameter `e`, though this was syntactically harmless.

**Fix:**
- Moved `preventDefault()`/`stopPropagation()` **after** a `chrome.runtime?.sendMessage` liveness check.
- If the extension context is dead, the handler now `return`s early so the browser handles the click normally.
- Renamed `catch` variable to `_err` to avoid shadowing.
- Added try/catch around the send.

**File Modified:** `extension/content.js`

**Status:** Resolved

**Note:** Reload the extension and the page to load the fixed content script (the screenshot showed an old injected version).

### 2026-06-26: Extension Context Invalidated (Expected MV3 Behavior)
**Description:** `Uncaught Error: Extension context invalidated` appears in the extensions error log.

**Root Cause:** Content scripts injected at `document_start` persist for the page's lifetime, but their `chrome.runtime` connection dies when the service worker unloads or the extension is reloaded. This is normal MV3 lifecycle behavior.

**Fix:** The content.js fix above now gracefully handles this case — no more TypeError, no more silently lost downloads.

**Status:** Resolved (side-effect of the content.js fix)

### 2026-06-26: Native Messaging Host Not Found (Setup Issue)
**Description:** `[Aria2] Native messaging error: Specified native messaging host not found. Extension ID: egjdjkfddjpgakdgemjnfmdochggdelf`

**Root Cause:**
- The `native-host/com.downstream.interceptor.json` manifest had placeholder values (`REPLACE_WITH_ABSOLUTE_PATH_TO_host.js` and `REPLACE_WITH_YOUR_EXTENSION_ID`).
- The manifest was never installed to Chrome's `NativeMessagingHosts` directory.

**Fix:**
- Updated `com.downstream.interceptor.json` with the correct absolute path to `host.js` and the actual extension ID.
- Copied the manifest to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.

**Files Modified:**
- `native-host/com.downstream.interceptor.json`
- Installed to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`

**Status:** Resolved (Chrome must be restarted for native host changes to take effect)

### 2026-06-26: Native Messaging Host immediately exits (Missing Node in GUI Environment)
**Description:** Chrome reports `[Aria2] Native messaging error: Native host has exited. Extension ID: egjdjkfddjpgakdgemjnfmdochggdelf` when attempting to intercept downloads.

**Root Cause:**
- GUI applications on macOS (such as Google Chrome) do not inherit environment variables defined in user shell configs (`.zshrc` / `.bash_profile`).
- As a result, the `#!/usr/bin/env node` shebang in `host.js` failed to find the `node` binary because it was not in Chrome's default PATH, causing the process to immediately crash on launch.

**Fix:**
- Created a wrapper script `native-host/host.sh` that dynamically locates the project's local Node.js binary (`.node-local/...`) or falls back to system paths.
- Updated `native-host/com.downstream.interceptor.json` to execute `host.sh` instead of `host.js` directly.
- Copied the updated manifest to the active Chrome NativeMessagingHosts folder.

**Files Modified / Added:**
- `native-host/host.sh` (new wrapper script)
- `native-host/com.downstream.interceptor.json` (updated target path)

**Status:** Resolved


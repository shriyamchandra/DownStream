// Environment detection + global error reporting.
export const DEBUG = false;

export function _log(msg) {
    if (DEBUG) console.log(`[DIAG] ${msg}`);
}

// True when running inside the Tauri WebView (vs a plain browser / Electron).
export const isTauri = window.__TAURI__ !== undefined;

window.onerror = function (message, source, lineno) {
    console.error(`[DownStream ERROR] ${message} at ${source}:${lineno}`);
};
window.onunhandledrejection = function (event) {
    console.error(`[DownStream UNHANDLED] ${event.reason}`);
};

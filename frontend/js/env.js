// Environment detection + global error reporting.
export const DEBUG = false;

export function _log(msg) {
    if (DEBUG) console.log(`[DIAG] ${msg}`);
}



window.onerror = function (message, source, lineno) {
    console.error(`[DownStream ERROR] ${message} at ${source}:${lineno}`);
};
window.onunhandledrejection = function (event) {
    console.error(`[DownStream UNHANDLED] ${event.reason}`);
};

// Entry point: apply theme, wire up the UI, and connect to the aria2 engine.
import './env.js'; // installs global error handlers
import { initTheme } from './theme.js';
import { client } from './transport.js';
import { callApi } from './api.js';
import { state } from './state.js';
import { getFileName } from './format.js';
import { refreshDownloads, loadSettings } from './downloads.js';
import { initEvents } from './events.js';

initTheme();
initEvents();

let refreshInterval = null;
const POLL_FAST = 1000;   // 1 s when visible
const POLL_SLOW = 10000;  // 10 s when hidden / minimised

function startPolling() {
    if (refreshInterval) clearInterval(refreshInterval);
    const interval = document.hidden ? POLL_SLOW : POLL_FAST;
    refreshInterval = setInterval(refreshDownloads, interval);
}

// On (re)connect, load settings, render once, then poll for live updates.
client.onConnect = () => {
    loadSettings();
    refreshDownloads();
    startPolling();
};

// Throttle polling when the window loses / gains visibility.
document.addEventListener('visibilitychange', () => {
    if (refreshInterval) startPolling();
});

// Push notifications from aria2 — refresh immediately, and toast on completion.
client.onMessage = async (data) => {
    if (data.method && data.method.startsWith('aria2.onDownload')) {
        refreshDownloads();
    }
    if (data.method === 'aria2.onDownloadComplete') {
        const gid = data.params[0].gid;
        const d = state.downloads.find(x => x.gid === gid);
        if (d) {
            callApi('/api/notify', {
                title: 'DownStream',
                message: `Download Complete: ${getFileName(d)}`
            });
        }
    }
};

window.addEventListener('beforeunload', () => {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
});

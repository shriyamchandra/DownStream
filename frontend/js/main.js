// Entry point: apply theme, wire up the UI, and connect to the aria2 engine.
import './env.js'; // installs global error handlers
import { initTheme } from './theme.js';
import { client } from './transport.js';
import { callApi } from './api.js';
import { state } from './state.js';
import { getFileName } from './format.js';
import { refreshDownloads, loadSettings, registerActions } from './downloads.js';
import { initEvents } from './events.js';

initTheme();
registerActions();
initEvents();

// On (re)connect, load settings, render once, then poll for live updates.
client.onConnect = () => {
    loadSettings();
    refreshDownloads();
    setInterval(refreshDownloads, 1000);
};

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

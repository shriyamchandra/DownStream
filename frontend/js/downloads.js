import { client } from './transport.js';
import { callApi } from './api.js';
import { state, MAX_SPEED_POINTS } from './state.js';
import { formatBytes, getFileName } from './format.js';
import { renderDownloads, updateBadge } from './render.js';
import { drawSpeedGraph } from './speedGraph.js';

// Pull the latest state from aria2, merge it onto persisted history, and render.
export async function refreshDownloads() {
    try {
        const active = await client.call('tellActive').catch(() => []);
        const waiting = await client.call('tellWaiting', [0, 100]).catch(() => []);
        const stopped = await client.call('tellStopped', [0, 100]).catch(() => []);
        const globalStat = await client.call('getGlobalStat').catch(() => ({ downloadSpeed: 0, uploadSpeed: 0 }));

        const liveMap = new Map();
        [...active, ...waiting, ...stopped].forEach(item => liveMap.set(item.gid, item));

        const historyList = await callApi('/api/history').catch(() => []);

        // Overlay fresh aria2 data on persisted history (history owns metadata).
        state.downloads = historyList.map(hItem => {
            const live = liveMap.get(hItem.gid);
            if (live) {
                return {
                    ...hItem,
                    status: live.status || hItem.status,
                    completedLength: live.completedLength || hItem.completedLength,
                    totalLength: live.totalLength || hItem.totalLength,
                    downloadSpeed: live.downloadSpeed || 0,
                    files: live.files || hItem.files,
                    dir: live.dir || hItem.dir,
                    numSeeders: live.numSeeders,
                    connections: live.connections,
                    uploadSpeed: live.uploadSpeed
                };
            }
            return { ...hItem, downloadSpeed: 0 };
        });

        // Include any live items not yet persisted (rare timing window).
        liveMap.forEach((live, gid) => {
            if (!historyList.some(h => h.gid === gid)) state.downloads.push(live);
        });

        document.getElementById('globalDl').innerText = formatBytes(globalStat.downloadSpeed) + '/s';
        document.getElementById('globalUl').innerText = formatBytes(globalStat.uploadSpeed) + '/s';

        const dlSpeed = parseInt(globalStat.downloadSpeed) || 0;
        state.speedHistory.push(dlSpeed);
        if (state.speedHistory.length > MAX_SPEED_POINTS) state.speedHistory.shift();
        drawSpeedGraph();

        updateBadge('badgeAll', state.downloads.length);
        updateBadge('badgeActive', state.downloads.filter(d => d.status === 'active' || d.status === 'waiting' || d.status === 'paused').length);
        updateBadge('badgeComplete', state.downloads.filter(d => d.status === 'complete').length);
        updateBadge('badgeFailed', state.downloads.filter(d => d.status === 'error' || d.status === 'removed').length);

        renderDownloads();
    } catch (e) {
        console.error('Failed to fetch data', e);
    }
}

// Load settings into state and populate the settings form.
export async function loadSettings() {
    try {
        state.appConfig = await callApi('/api/settings');
        document.getElementById('prefPlayer').value = state.appConfig.preferredPlayer;
        document.getElementById('prefDir').value = state.appConfig.downloadDir;
        document.getElementById('prefTheme').value = localStorage.getItem('appTheme') || 'system';
    } catch (e) {
        console.error('Failed to load settings', e);
    }
}

// Register the row-action handlers on window (called from inline onclick=...).
export function registerActions() {
    window.toggleExpand = (gid, e) => {
        if (e.target.closest('.row-actions') || e.target.closest('button') || e.target.closest('a')) return;
        if (state.expandedGids.has(gid)) state.expandedGids.delete(gid);
        else state.expandedGids.add(gid);
        renderDownloads();
    };

    window.pauseDl = (gid, e) => {
        if (e) e.stopPropagation();
        client.call('pause', [gid]).catch(() => {});
    };

    window.resumeDl = (gid, e) => {
        if (e) e.stopPropagation();
        client.call('unpause', [gid]).catch(() => {});
    };

    window.deleteDownload = async (gid, isHistorical, e) => {
        if (e) e.stopPropagation();
        const d = state.downloads.find(x => x.gid === gid);
        if (!d) return;

        const filename = getFileName(d);
        const filepath = d.files?.[0]?.path;
        const hasFiles = filepath && parseInt(d.completedLength) > 0;

        let deleteFiles = false;
        if (hasFiles) {
            deleteFiles = confirm(`Do you want to delete the downloaded files from disk as well to keep your drive clean?\n\nFile: ${filename}`);
        } else if (!isHistorical) {
            if (!confirm(`Are you sure you want to cancel downloading: ${filename}?`)) return;
        } else {
            if (!confirm(`Are you sure you want to remove ${filename} from history?`)) return;
        }

        try {
            await callApi('/api/history/delete', { gid, deleteFile: deleteFiles });
            refreshDownloads();
        } catch (e) {
            console.error('Failed to delete download', e);
        }
    };

    window.restartDl = async (gid, e) => {
        if (e) e.stopPropagation();
        const d = state.downloads.find(x => x.gid === gid);
        if (!d) return;
        if (!confirm(`Do you want to restart download: ${d.filename}?`)) return;

        try {
            const res = await callApi('/api/history/retry', { gid });
            if (res.success) refreshDownloads();
            else alert('Failed to restart: ' + (res.error || 'Unknown error'));
        } catch (e) {
            alert('Failed to restart download.');
        }
    };

    window.streamFile = async (gid, e) => {
        if (e) e.stopPropagation();
        const d = state.downloads.find(x => x.gid === gid);
        if (!d) return;
        const filename = getFileName(d);
        // Prefer the full path from aria2 (avoids basename collisions across categories).
        const filepath = d.files && d.files[0] && d.files[0].path ? d.files[0].path : null;
        try {
            const data = await callApi('/api/stream', { filename, filepath });
            if (data.error) alert('Error: ' + data.error);
        } catch (e) {
            alert('Failed to launch stream. Ensure the backend is running.');
        }
    };

    window.showInFinder = async (gid, e) => {
        if (e) e.stopPropagation();
        const d = state.downloads.find(x => x.gid === gid);
        const filepath = d?.files?.[0]?.path;
        if (!filepath) return alert('File path not found.');
        try {
            await callApi('/api/showInFinder', { filepath });
        } catch (e) {
            console.error(e);
        }
    };

    window.setGlobalSpeedLimit = async (speed) => {
        await client.call('changeGlobalOption', [{ 'max-overall-download-limit': speed }]).catch(() => {});
    };
}

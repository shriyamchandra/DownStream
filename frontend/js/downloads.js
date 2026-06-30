import { client } from './transport.js';
import { callApi } from './api.js';
import { state, MAX_SPEED_POINTS } from './state.js';
import { formatBytes, getFileName } from './format.js';
import { renderDownloads, updateBadge } from './render.js';
import { drawSpeedGraph } from './speedGraph.js';
import { showToast } from './toast.js';

export async function refreshDownloads() {
    try {
        const activeMerges = await callApi('/api/active-merges').catch(() => ({}));
        state.activeMerges = activeMerges;
        
        const activeRaw = await client.call('tellActive').catch(() => []);
        const waitingRaw = await client.call('tellWaiting', [0, 100]).catch(() => []);
        const stoppedRaw = await client.call('tellStopped', [0, 100]).catch(() => []);
        const globalStat = await client.call('getGlobalStat').catch(() => ({ downloadSpeed: 0, uploadSpeed: 0 }));

        const active = [];
        const waiting = [];
        const stopped = [];
        const processedMergedGids = new Set();

        const processItem = (item, targetList) => {
            if (activeMerges && activeMerges[item.gid]) {
                const info = activeMerges[item.gid];
                if (!processedMergedGids.has(info.mergedGid)) {
                    processedMergedGids.add(info.mergedGid);

                    const allRaw = [...activeRaw, ...waitingRaw, ...stoppedRaw];
                    const videoAd = allRaw.find(x => x.gid === info.videoGid) || { totalLength: '0', completedLength: '0', downloadSpeed: '0', status: 'complete' };
                    const audioAd = allRaw.find(x => x.gid === info.audioGid) || { totalLength: '0', completedLength: '0', downloadSpeed: '0', status: 'complete' };

                    const videoDone = parseInt(videoAd.completedLength) || 0;
                    const videoTotal = parseInt(videoAd.totalLength) || 0;
                    const audioDone = parseInt(audioAd.completedLength) || 0;
                    const audioTotal = parseInt(audioAd.totalLength) || 0;

                    const combinedDone = videoDone + audioDone;
                    const combinedTotal = videoTotal + audioTotal;
                    const combinedSpeed = (parseInt(videoAd.downloadSpeed) || 0) + (parseInt(audioAd.downloadSpeed) || 0);

                    let status = item.status;
                    if (videoAd.status === 'paused' && audioAd.status === 'paused') {
                        status = 'paused';
                    }

                    const pathJoin = (dir, name) => {
                        if (!dir) return name;
                        const cleanDir = dir.replace(/[/\\]+$/, '');
                        return `${cleanDir}/${name}`;
                    };

                    targetList.push({
                        gid: info.mergedGid,
                        status: status,
                        totalLength: String(combinedTotal || 1000000),
                        completedLength: String(combinedDone),
                        downloadSpeed: String(combinedSpeed),
                        dir: info.dir,
                        filename: info.finalName,
                        files: [{ path: pathJoin(info.dir, info.finalName) }],
                        category: 'Videos',
                        connections: (parseInt(videoAd.connections) || 0) + (parseInt(audioAd.connections) || 0),
                        numSeeders: (parseInt(videoAd.numSeeders) || 0) + (parseInt(audioAd.numSeeders) || 0),
                        uploadSpeed: (parseInt(videoAd.uploadSpeed) || 0) + (parseInt(audioAd.uploadSpeed) || 0)
                    });
                }
            } else {
                if (activeMerges && activeMerges[item.gid]) return;
                targetList.push(item);
            }
        };

        activeRaw.forEach(item => processItem(item, active));
        waitingRaw.forEach(item => processItem(item, waiting));
        stoppedRaw.forEach(item => processItem(item, stopped));

        const liveMap = new Map();
        [...active, ...waiting, ...stopped].forEach(item => liveMap.set(item.gid, item));

        const historyList = await callApi('/api/history').catch(() => []);

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
            // YouTube downloads run via yt-dlp, not aria2 — keep speed from history
            const isYtDownload = typeof hItem.gid === 'string' && hItem.gid.startsWith('youtube-');
            const isActiveYt = isYtDownload && (hItem.status === 'active' || hItem.status === 'merging');
            return {
                ...hItem,
                downloadSpeed: isActiveYt ? (hItem.downloadSpeed || 0) : 0
            };
        });

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
        updateBadge('badgeActive', state.downloads.filter(d => d.status === 'active' || d.status === 'waiting' || d.status === 'paused' || d.status === 'merging').length);
        updateBadge('badgeComplete', state.downloads.filter(d => d.status === 'complete').length);
        updateBadge('badgeFailed', state.downloads.filter(d => d.status === 'error' || d.status === 'removed').length);

        renderDownloads();
    } catch (e) {
        console.error('Failed to fetch data', e);
    }
}

export async function loadSettings() {
    try {
        state.appConfig = await callApi('/api/settings');
        document.getElementById('prefPlayer').value = state.appConfig.preferredPlayer;
        document.getElementById('prefDir').value = state.appConfig.downloadDir;
        document.getElementById('prefCookiesBrowser').value = state.appConfig.youtubeCookiesBrowser || '';
        document.getElementById('prefTheme').value = localStorage.getItem('appTheme') || 'system';
    } catch (e) {
        console.error('Failed to load settings', e);
    }
}

export function toggleExpand(gid, e) {
    if (e && (e.target.closest('.row-actions') || e.target.closest('button') || e.target.closest('a'))) return;
    if (state.expandedGids.has(gid)) state.expandedGids.delete(gid);
    else state.expandedGids.add(gid);
    renderDownloads();
}

export async function pauseDl(gid) {
    try {
        await callApi('/api/downloads/pause', { gid });
        refreshDownloads();
    } catch (err) {
        console.error('Failed to pause download:', err);
        showToast('Pause Failed', err.message || err, 'error');
        throw err;
    }
}

export async function resumeDl(gid) {
    try {
        await callApi('/api/downloads/resume', { gid });
        refreshDownloads();
    } catch (err) {
        console.error('Failed to resume download:', err);
        showToast('Resume Failed', err.message || err, 'error');
        throw err;
    }
}

export async function deleteDownload(gid, isHistorical) {
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
        throw e;
    }
}

export async function restartDl(gid) {
    const d = state.downloads.find(x => x.gid === gid);
    if (!d) return;
    if (!confirm(`Do you want to restart download: ${d.filename}?`)) return;

    try {
        const res = await callApi('/api/history/retry', { gid });
        if (res.success) refreshDownloads();
        else showToast('Restart Failed', res.error || 'Unknown error', 'error');
    } catch (e) {
        showToast('Restart Failed', 'Failed to restart download.', 'error');
        throw e;
    }
}

export async function streamFile(gid) {
    const d = state.downloads.find(x => x.gid === gid);
    if (!d) return;
    const filename = getFileName(d);
    const filepath = d.files && d.files[0] && d.files[0].path ? d.files[0].path : null;
    try {
        const data = await callApi('/api/stream', { filename, filepath, category: d.category, gid });
        if (data.error) showToast('Streaming Error', data.error, 'error');
    } catch (e) {
        showToast('Streaming Failed', 'Failed to launch stream. Ensure the backend is running.', 'error');
        throw e;
    }
}

export async function showInFinder(gid) {
    const d = state.downloads.find(x => x.gid === gid);
    const filepath = d?.files?.[0]?.path;
    if (!filepath) return showToast('File Not Found', 'The requested file path could not be located.', 'error');
    try {
        await callApi('/api/showInFinder', { filepath, filename: getFileName(d), category: d?.category, gid });
    } catch (e) {
        console.error(e);
        throw e;
    }
}

export async function setGlobalSpeedLimit(speed) {
    try {
        await client.call('changeGlobalOption', [{ 'max-overall-download-limit': speed }]);
    } catch (err) {
        console.error('Failed to set global speed limit:', err);
        showToast('Speed Limit Error', err.message || err, 'error');
        throw err;
    }
}

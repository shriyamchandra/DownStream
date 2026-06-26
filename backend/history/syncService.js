const path = require('path');

const ACTIVE_STATUSES = ['active', 'waiting', 'paused'];

// Periodically reconciles aria2's live download state into the history store:
// adds new downloads, updates progress/status, marks vanished active downloads
// as 'removed', and caps the history size.
module.exports = function createSyncService({ rpc, history, config }) {
    async function syncOnce() {
        try {
            const active = await rpc.call('tellActive').catch(() => null);
            const waiting = await rpc.call('tellWaiting', [0, 1000]).catch(() => null);
            const stopped = await rpc.call('tellStopped', [0, 1000]).catch(() => null);

            // Require a COMPLETE snapshot. If any query failed we can't tell
            // "no such downloads" from "RPC error" — proceeding would wrongly flag
            // live downloads as 'removed'. Skip this cycle.
            if (!active || !waiting || !stopped) return;

            const ariaDownloads = [
                ...(active.result || []),
                ...(waiting.result || []),
                ...(stopped.result || [])
            ];
            const items = history.items;
            let changed = false;

            for (const ad of ariaDownloads) {
                const gid = ad.gid;
                const status = ad.status;
                const totalLength = parseInt(ad.totalLength) || 0;
                const completedLength = parseInt(ad.completedLength) || 0;
                const downloadSpeed = parseInt(ad.downloadSpeed) || 0;
                const files = ad.files || [];

                let urls = [];
                if (ad.files && ad.files.length > 0) {
                    ad.files.forEach(f => {
                        if (f.uris && f.uris.length > 0) {
                            f.uris.forEach(u => urls.push(u.uri));
                        }
                    });
                }

                const dir = ad.dir || config.data.downloadDir;
                let category = '';
                if (dir.startsWith(config.data.downloadDir)) {
                    const sub = dir.slice(config.data.downloadDir.length).replace(/^[/\\]+/, '');
                    if (sub) category = sub.split(/[/\\]/)[0];
                }

                let filename = 'Unknown File';
                if (ad.bittorrent && ad.bittorrent.info && ad.bittorrent.info.name) {
                    filename = ad.bittorrent.info.name;
                } else if (ad.files && ad.files.length > 0) {
                    if (ad.files[0].path) {
                        filename = path.basename(ad.files[0].path);
                    } else if (ad.files[0].uris && ad.files[0].uris.length > 0) {
                        try {
                            const urlObj = new URL(ad.files[0].uris[0].uri);
                            filename = path.basename(urlObj.pathname) || 'downloaded_file';
                        } catch (e) {
                            filename = 'downloaded_file';
                        }
                    }
                }

                let item = items.find(x => x.gid === gid);
                if (!item) {
                    item = {
                        gid,
                        filename,
                        urls,
                        totalLength,
                        completedLength,
                        status,
                        dir,
                        files,
                        category,
                        downloadSpeed,
                        addedDate: new Date().toISOString(),
                        completedDate: status === 'complete' ? new Date().toISOString() : null,
                        errorMessage: ad.errorMessage || ''
                    };
                    items.unshift(item);
                    changed = true;
                } else if (
                    item.status !== status ||
                    item.completedLength !== completedLength ||
                    item.totalLength !== totalLength ||
                    item.downloadSpeed !== downloadSpeed
                ) {
                    item.status = status;
                    item.completedLength = completedLength;
                    item.totalLength = totalLength;
                    item.downloadSpeed = downloadSpeed;
                    item.dir = dir;
                    item.files = files;
                    if (ad.errorMessage) item.errorMessage = ad.errorMessage;
                    if (status === 'complete' && !item.completedDate) {
                        item.completedDate = new Date().toISOString();
                    }
                    changed = true;
                }
            }

            // Active downloads that vanished from aria2 are marked 'removed'.
            for (const item of items) {
                if (ACTIVE_STATUSES.includes(item.status)) {
                    const stillInAria = ariaDownloads.some(ad => ad.gid === item.gid);
                    if (!stillInAria) {
                        item.status = 'removed';
                        item.downloadSpeed = 0;
                        changed = true;
                    }
                }
            }

            // Cap history size: drop oldest finished entries, never active ones.
            if (items.length > config.maxHistory) {
                for (let i = items.length - 1; i >= 0 && items.length > config.maxHistory; i--) {
                    if (!ACTIVE_STATUSES.includes(items[i].status)) {
                        items.splice(i, 1);
                        changed = true;
                    }
                }
            }

            if (changed) history.save();
        } catch (e) {
            console.error('Error in syncHistoryWithAria2:', e);
        }
    }

    function start(intervalMs = 2500) {
        return setInterval(syncOnce, intervalMs);
    }

    return { syncOnce, start };
};

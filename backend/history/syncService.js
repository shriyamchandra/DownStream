const path = require('path');

const ACTIVE_STATUSES = ['active', 'waiting', 'paused'];

function getFilenameFromUrl(url, fallback) {
    try {
        const urlObj = new URL(url);
        return path.basename(urlObj.pathname) || fallback;
    } catch (e) {
        return fallback;
    }
}

// Periodically reconciles aria2's live download state into the history store:
// adds new downloads, updates progress/status, marks vanished active downloads
// as 'removed', and caps the history size.
module.exports = function createSyncService({ rpc, history, config, activeMerges, saveActiveMerges, notifier }) {
    let syncing = false;
    async function syncOnce() {
        if (syncing) return;
        syncing = true;
        try {
            const active = await rpc.call('tellActive').catch(() => null);
            const waiting = await rpc.call('tellWaiting', [0, 1000]).catch(() => null);
            const stopped = await rpc.call('tellStopped', [0, 1000]).catch(() => null);

            // Require a COMPLETE snapshot. If any query failed we can't tell
            // "no such downloads" from "RPC error" — proceeding would wrongly flag
            // live downloads as 'removed'. Skip this cycle.
            if (!active || !waiting || !stopped) return;

            const rawAriaDownloads = [
                ...(active.result || []),
                ...(waiting.result || []),
                ...(stopped.result || [])
            ];

            const ariaDownloads = [];
            const processedMergedGids = new Set();
            const rawGidSet = new Set(rawAriaDownloads.map(ad => ad.gid));

            const executeMerge = (info) => {
                const ffmpegPath = require('ffmpeg-static');
                const { execFile } = require('child_process');
                const fs = require('fs');

                // Derive video/audio filenames from type + myFile/otherFile
                let videoFile, audioFile;
                if (info.type === 'video') {
                    videoFile = info.myFile;
                    audioFile = info.otherFile;
                } else {
                    videoFile = info.otherFile;
                    audioFile = info.myFile;
                }

                const videoPath = path.join(info.dir, videoFile);
                const audioPath = path.join(info.dir, audioFile);
                const finalPath = path.join(info.dir, info.finalName);

                const ffmpegArgs = [
                    '-i', videoPath,
                    '-i', audioPath,
                    '-c:v', 'copy',
                    '-c:a', 'aac',
                    '-y',
                    finalPath
                ];

                console.log(`[FFmpeg] Merging: video=${videoFile}, audio=${audioFile} -> ${info.finalName}`);
                if (notifier) notifier.notify('DownStream', `Merging audio and video for: ${info.finalName}`);

                execFile(ffmpegPath, ffmpegArgs, (err) => {
                    // Clean up all merge tracking entries
                    if (info.videoGid) activeMerges.delete(info.videoGid);
                    if (info.audioGid) activeMerges.delete(info.audioGid);
                    activeMerges.delete(info.mergedGid);
                    if (typeof saveActiveMerges === 'function') saveActiveMerges();

                    if (err) {
                        console.error('[FFmpeg] Merge failed:', err);
                        if (notifier) notifier.notify('DownStream', `Error merging video and audio.`);
                        
                        const item = history.items.find(x => x.gid === info.mergedGid);
                        if (item) {
                            item.status = 'error';
                            item.errorMessage = 'FFmpeg merge failed';
                            history.save();
                        }
                    } else {
                        console.log('[FFmpeg] Merge completed successfully:', finalPath);
                        if (notifier) notifier.notify('DownStream', `Merge complete! Video ready: ${info.finalName}`);

                        try {
                            if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                        } catch (cleanupErr) {
                            console.error('[FFmpeg] Failed to clean up temp files:', cleanupErr);
                        }

                        const item = history.items.find(x => x.gid === info.mergedGid);
                        if (item) {
                            item.status = 'complete';
                            item.completedLength = item.totalLength;
                            item.completedDate = new Date().toISOString();
                            history.save();
                        }
                    }
                });
            };

            for (const ad of rawAriaDownloads) {
                const gid = ad.gid;
                if (activeMerges && activeMerges.has(gid)) {
                    const info = activeMerges.get(gid);
                    
                    // Skip if we already processed this merge group
                    if (processedMergedGids.has(info.mergedGid)) continue;
                    processedMergedGids.add(info.mergedGid);

                    // Find both tracks in the raw aria2 data
                    const videoAd = rawAriaDownloads.find(x => x.gid === info.videoGid);
                    const audioAd = rawAriaDownloads.find(x => x.gid === info.audioGid);

                    // If both tracks are actually completed in aria2, trigger merge
                    if (videoAd && audioAd && videoAd.status === 'complete' && audioAd.status === 'complete') {
                        console.log(`[Sync] Both tracks complete for ${info.finalName}, triggering merge`);
                        rpc.call('removeDownloadResult', [info.videoGid]).catch(() => {});
                        rpc.call('removeDownloadResult', [info.audioGid]).catch(() => {});

                        executeMerge(info);
                        continue;
                    }

                    // Calculate combined progress from both tracks
                    const videoDone = videoAd ? (parseInt(videoAd.completedLength) || 0) : 0;
                    const videoTotal = videoAd ? (parseInt(videoAd.totalLength) || 0) : 0;
                    const audioDone = audioAd ? (parseInt(audioAd.completedLength) || 0) : 0;
                    const audioTotal = audioAd ? (parseInt(audioAd.totalLength) || 0) : 0;

                    const combinedDone = videoDone + audioDone;
                    const combinedTotal = videoTotal + audioTotal;
                    const combinedSpeed = (videoAd ? (parseInt(videoAd.downloadSpeed) || 0) : 0)
                                        + (audioAd ? (parseInt(audioAd.downloadSpeed) || 0) : 0);

                    // Determine combined status
                    let combinedStatus = 'active';
                    const vStatus = videoAd ? videoAd.status : 'complete';
                    const aStatus = audioAd ? audioAd.status : 'complete';
                    if (vStatus === 'paused' && aStatus === 'paused') {
                        combinedStatus = 'paused';
                    } else if (vStatus === 'error' || aStatus === 'error') {
                        combinedStatus = 'error';
                    }

                    ariaDownloads.push({
                        gid: info.mergedGid,
                        status: combinedStatus,
                        totalLength: String(combinedTotal || 1000000),
                        completedLength: String(combinedDone),
                        downloadSpeed: String(combinedSpeed),
                        dir: info.dir,
                        files: [{ path: path.join(info.dir, info.finalName) }],
                        errorMessage: (videoAd && videoAd.errorMessage) || (audioAd && audioAd.errorMessage) || ''
                    });

                } else {
                    ariaDownloads.push(ad);
                }
            }

            // Clean up stale merge entries whose GIDs have vanished from aria2 entirely
            if (activeMerges && activeMerges.size > 0) {
                const staleMergedGids = new Set();
                for (const [key, info] of activeMerges.entries()) {
                    // Only process mergedGid entries (skip individual track entries)
                    if (!key.startsWith('merged-')) continue;
                    if (processedMergedGids.has(info.mergedGid)) continue;
                    
                    // Neither track exists in aria2 anymore — this is a zombie
                    const videoExists = info.videoGid && rawGidSet.has(info.videoGid);
                    const audioExists = info.audioGid && rawGidSet.has(info.audioGid);
                    if (!videoExists && !audioExists) {
                        staleMergedGids.add(info.mergedGid);
                        console.log(`[Sync] Cleaning stale merge entry: ${info.mergedGid} (${info.finalName})`);
                    }
                }
                
                if (staleMergedGids.size > 0) {
                    for (const [key, info] of [...activeMerges.entries()]) {
                        if (staleMergedGids.has(info.mergedGid)) {
                            activeMerges.delete(key);
                        }
                    }
                    if (typeof saveActiveMerges === 'function') saveActiveMerges();
                    
                    // Mark corresponding history items as removed
                    for (const mergedGid of staleMergedGids) {
                        const item = history.items.find(x => x.gid === mergedGid);
                        if (item && ACTIVE_STATUSES.includes(item.status)) {
                            item.status = 'removed';
                            item.downloadSpeed = 0;
                        }
                    }
                }
            }

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
                        filename = getFilenameFromUrl(ad.files[0].uris[0].uri, 'downloaded_file');
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
                    if (item.gid.startsWith('youtube-')) {
                        continue;
                    }
                    const stillInAria = ariaDownloads.some(ad => ad.gid === item.gid);
                    if (!stillInAria) {
                        // Skip marking as removed if we are in transition or merging
                        if (activeMerges && activeMerges.has(item.gid)) {
                            continue;
                        }
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
        } finally {
            syncing = false;
        }
    }

    function start(intervalMs = 2500) {
        return setInterval(syncOnce, intervalMs);
    }

    return { syncOnce, start };
};

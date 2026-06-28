const express = require('express');
const fs = require('fs');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ACTIVE_STATUSES = ['active', 'waiting', 'paused'];

// History endpoints: list, clear finished entries, delete (with optional file
// removal), and retry a failed/removed download from scratch.
module.exports = function historyRoutes({ rpc, history, config, pathGuard, activeMerges, saveActiveMerges, activeYoutubeDownloads, startYoutubeDownload }) {
    const router = express.Router();

    router.get('/api/history', (req, res) => {
        res.json(history.items);
    });

    router.post('/api/history/clear-completed', (req, res) => {
        const beforeCount = history.items.length;
        history.setItems(history.items.filter(item => ACTIVE_STATUSES.includes(item.status)));
        if (history.items.length !== beforeCount) history.save();
        res.json({ success: true, count: beforeCount - history.items.length });
    });

    router.post('/api/history/delete', async (req, res) => {
        const { gid, deleteFile } = req.body;
        if (!gid) return res.status(400).json({ error: 'GID required' });

        const itemIndex = history.items.findIndex(x => x.gid === gid);
        if (itemIndex === -1) return res.status(404).json({ error: 'Item not found in history' });

        const item = history.items[itemIndex];

        try {
            if (gid.startsWith('youtube-')) {
                if (activeYoutubeDownloads && activeYoutubeDownloads.has(gid)) {
                    const activeInfo = activeYoutubeDownloads.get(gid);
                    if (activeInfo) {
                        activeInfo.isPausedIntentionally = true;
                        if (activeInfo.process) activeInfo.process.kill('SIGKILL');
                        activeYoutubeDownloads.delete(gid);
                    }
                }
                // Clean up any .temp-yt.* files for this item
                const currentExt = path.extname(item.filename);
                const stem = currentExt ? item.filename.slice(0, -currentExt.length) : item.filename;
                try {
                    const dirFiles = fs.readdirSync(config.data.downloadDir);
                    const prefix = `${stem}.temp-yt.`;
                    dirFiles.filter(f => f.startsWith(prefix)).forEach(f => {
                        try { fs.unlinkSync(path.join(config.data.downloadDir, f)); } catch (e) {}
                    });
                } catch (e) {}
            } else if (gid.startsWith('merged-') && activeMerges && activeMerges.has(gid)) {
                const info = activeMerges.get(gid);
                
                // Cancel/remove both segments
                if (info.videoGid) {
                    await rpc.call('remove', [info.videoGid]).catch(() => {});
                    await rpc.call('removeDownloadResult', [info.videoGid]).catch(() => {});
                }
                if (info.audioGid) {
                    await rpc.call('remove', [info.audioGid]).catch(() => {});
                    await rpc.call('removeDownloadResult', [info.audioGid]).catch(() => {});
                }

                // Delete temporary video/audio files
                const fs = require('fs');
                if (info.myFile) {
                    const videoPath = path.join(info.dir, info.myFile);
                    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                    if (fs.existsSync(videoPath + '.aria2')) fs.unlinkSync(videoPath + '.aria2');
                }
                if (info.otherFile) {
                    const audioPath = path.join(info.dir, info.otherFile);
                    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                    if (fs.existsSync(audioPath + '.aria2')) fs.unlinkSync(audioPath + '.aria2');
                }

                // Clean active merges Map
                if (info.videoGid) activeMerges.delete(info.videoGid);
                if (info.audioGid) activeMerges.delete(info.audioGid);
                activeMerges.delete(info.mergedGid);
                if (typeof saveActiveMerges === 'function') saveActiveMerges();
            } else {
                if (ACTIVE_STATUSES.includes(item.status)) {
                    await rpc.call('remove', [gid]);
                } else {
                    await rpc.call('removeDownloadResult', [gid]);
                }
            }
        } catch (e) {
            console.warn(`RPC deletion request failed for GID ${gid}:`, e.message || e);
        }

        if (deleteFile) {
            let filepaths = [];
            if (item.files && item.files.length > 0) {
                filepaths = item.files.map(f => f.path).filter(p => p);
            }
            if (filepaths.length === 0) {
                // Resolve with category subfolder when available
                const baseDir = (item.category)
                    ? path.join(config.data.downloadDir, item.category)
                    : (item.dir || config.data.downloadDir);
                filepaths.push(path.join(baseDir, item.filename));
            }

            filepaths.forEach(filepath => {
                if (pathGuard.isWithin(filepath)) {
                    try {
                        if (fs.existsSync(filepath)) {
                            const stat = fs.statSync(filepath);
                            if (stat.isDirectory()) {
                                fs.rmSync(filepath, { recursive: true, force: true });
                            } else {
                                fs.unlinkSync(filepath);
                            }
                        }
                        if (fs.existsSync(filepath + '.aria2')) fs.unlinkSync(filepath + '.aria2');
                    } catch (e) {
                        console.error(`Failed to delete file ${filepath}:`, e);
                    }
                }
            });
        }

        // Re-resolve by gid: the sync loop may have mutated the list during the
        // await above, so the original index can no longer be trusted.
        const delIndex = history.items.findIndex(x => x.gid === gid);
        if (delIndex !== -1) history.items.splice(delIndex, 1);
        history.save();
        res.json({ success: true });
    });

    router.post('/api/history/retry', async (req, res) => {
        const { gid } = req.body;
        if (!gid) return res.status(400).json({ error: 'GID required' });

        const itemIndex = history.items.findIndex(x => x.gid === gid);
        if (itemIndex === -1) return res.status(404).json({ error: 'Item not found' });

        const item = history.items[itemIndex];

        if (gid.startsWith('youtube-')) {
            try {
                // Delete old partial .temp-yt.* files
                const currentExt = path.extname(item.filename);
                const stem = currentExt ? item.filename.slice(0, -currentExt.length) : item.filename;
                try {
                    const dirFiles = fs.readdirSync(config.data.downloadDir);
                    const prefix = `${stem}.temp-yt.`;
                    dirFiles.filter(f => f.startsWith(prefix)).forEach(f => {
                        try { fs.unlinkSync(path.join(config.data.downloadDir, f)); } catch (e) {}
                    });
                } catch (e) {}
                
                // Restart download fresh
                item.status = 'active';
                item.completedLength = 0;
                item.downloadSpeed = 0;
                history.save();
                
                startYoutubeDownload(gid, item.urls[0], item.filename, item.formatId, item.chosenExt);
                return res.json({ success: true, newGid: gid });
            } catch (e) {
                console.error('[YouTube Retry] Failed to restart:', e);
                return res.status(500).json({ error: 'Failed to restart download.' });
            }
        }

        if (!item.urls || item.urls.length === 0) {
            return res.status(400).json({ error: 'No URLs available to redownload' });
        }

        try {
            const options = {};
            if (item.filename && !item.filename.startsWith('Unknown')) {
                options.out = item.filename;
            }
            if (item.category && config.data.downloadDir) {
                options.dir = path.join(config.data.downloadDir, item.category);
            } else {
                options.dir = config.data.downloadDir;
            }

            // A retry must start from byte 0. If a stale partial file and its
            // .aria2 control file are left on disk, aria2 (-c/--continue) tries to
            // RESUME them — which fails on servers without range support, so the
            // "restart" never actually restarts. Clear them first.
            const cleanupTargets = [];
            if (item.files && item.files.length > 0) {
                item.files.forEach(f => { if (f.path) cleanupTargets.push(f.path); });
            }
            const outName = options.out || item.filename;
            if (outName && !String(outName).startsWith('Unknown')) {
                cleanupTargets.push(path.join(options.dir, outName));
                if (item.dir) cleanupTargets.push(path.join(item.dir, outName));
            }
            [...new Set(cleanupTargets)].forEach(fp => {
                try {
                    if (!pathGuard.isWithin(fp)) return; // stay inside download dir
                    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) fs.unlinkSync(fp);
                    if (fs.existsSync(fp + '.aria2')) fs.unlinkSync(fp + '.aria2');
                } catch (e) {
                    console.error('Retry cleanup failed for', fp, e);
                }
            });

            // Force a fresh download even if the output file still exists.
            options.allowOverwrite = 'true';
            options.continue = 'false';

            const response = await rpc.call('addUri', [[item.urls[0]], options]);
            if (response.error) {
                return res.status(500).json({ error: response.error.message });
            }

            // Re-resolve by gid: the list may have been mutated during the await.
            const retryIndex = history.items.findIndex(x => x.gid === gid);
            if (retryIndex !== -1) history.items.splice(retryIndex, 1);
            history.save();

            res.json({ success: true, newGid: response.result });
        } catch (e) {
            res.status(500).json({ error: 'Failed to restart download.' });
        }
    });

    router.post('/api/downloads/pause', async (req, res) => {
        const { gid } = req.body;
        if (!gid) return res.status(400).json({ error: 'GID required' });

        try {
            if (gid.startsWith('youtube-')) {
                if (activeYoutubeDownloads && activeYoutubeDownloads.has(gid)) {
                    const activeInfo = activeYoutubeDownloads.get(gid);
                    if (activeInfo) {
                        activeInfo.isPausedIntentionally = true;
                        if (activeInfo.process) activeInfo.process.kill('SIGKILL');
                        activeYoutubeDownloads.delete(gid);
                    }
                }
                const item = history.items.find(x => x.gid === gid);
                if (item) {
                    item.status = 'paused';
                    item.downloadSpeed = 0;
                    history.save();
                }
                return res.json({ success: true });
            } else if (gid.startsWith('merged-') && activeMerges && activeMerges.has(gid)) {
                const info = activeMerges.get(gid);
                if (info.videoGid) await rpc.call('pause', [info.videoGid]).catch(() => {});
                if (info.audioGid) await rpc.call('pause', [info.audioGid]).catch(() => {});
            } else {
                await rpc.call('pause', [gid]);
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Failed to pause download.' });
        }
    });

    router.post('/api/downloads/resume', async (req, res) => {
        const { gid } = req.body;
        if (!gid) return res.status(400).json({ error: 'GID required' });

        try {
            if (gid.startsWith('youtube-')) {
                const item = history.items.find(x => x.gid === gid);
                if (item) {
                    item.status = 'active';
                    history.save();
                    startYoutubeDownload(gid, item.urls[0], item.filename, item.formatId, item.chosenExt);
                }
                return res.json({ success: true });
            } else if (gid.startsWith('merged-') && activeMerges && activeMerges.has(gid)) {
                const info = activeMerges.get(gid);
                
                const ytUrl = info.videoOpts && info.videoOpts.referer;
                if (ytUrl && (ytUrl.includes('youtube.com') || ytUrl.includes('youtu.be'))) {
                    console.log(`[Resume] Refreshing YouTube URLs for ${info.finalName} from referer: ${ytUrl}`);
                    
                    const findNodeRuntime = () => {
                        if (process.argv[0] && process.argv[0].includes('node') && !process.argv[0].includes('Electron') && !process.argv[0].includes('downstream')) {
                            return process.argv[0];
                        }
                        const localNode = path.join(config.projectRoot, '.node-local', 'node-v22.13.0-darwin-arm64', 'bin', 'node');
                        if (fs.existsSync(localNode)) return localNode;
                        return 'node';
                    };
                    
                    const packagedYtDlp = process.resourcesPath ? path.join(process.resourcesPath, 'yt-dlp') : '';
                    const localYtDlp = path.join(config.projectRoot, 'bin', 'yt-dlp');
                    const ytDlpPath = (packagedYtDlp && fs.existsSync(packagedYtDlp)) ? packagedYtDlp : localYtDlp;
                    
                    const formatSpec = info.formatId ? `${info.formatId}+ba` : 'bestvideo+bestaudio/best';
                    const { execFile } = require('child_process');
                    
                    const ytDlpArgs = [
                        '-j',
                        '-f', formatSpec,
                        '--user-agent', USER_AGENT,
                        '--js-runtimes', `node:${findNodeRuntime()}`,
                        ytUrl
                    ];
                    
                    execFile(ytDlpPath, ytDlpArgs, { maxBuffer: 15 * 1024 * 1024 }, async (err, stdout, stderr) => {
                        if (err) {
                            console.error('[Resume] Failed to re-resolve download URLs:', err.message);
                            return res.status(500).json({ error: 'Failed to refresh YouTube download links.' });
                        }
                        
                        try {
                            const metadata = JSON.parse(stdout);
                            const reqFormats = metadata.requested_formats || [];
                            if (reqFormats.length >= 2) {
                                const videoInfo = reqFormats[0];
                                const audioInfo = reqFormats[1];

                                const videoUrl = videoInfo.url;
                                const audioUrl = audioInfo.url;

                                const videoHeadersMap = videoInfo.http_headers || {};
                                const videoUA = videoHeadersMap['User-Agent'] || USER_AGENT;
                                const videoHeaders = Object.entries(videoHeadersMap)
                                    .filter(([k]) => k.toLowerCase() !== 'user-agent')
                                    .map(([k, v]) => `${k}: ${v}`);

                                const audioHeadersMap = audioInfo.http_headers || {};
                                const audioUA = audioHeadersMap['User-Agent'] || USER_AGENT;
                                const audioHeaders = Object.entries(audioHeadersMap)
                                    .filter(([k]) => k.toLowerCase() !== 'user-agent')
                                    .map(([k, v]) => `${k}: ${v}`);
                                
                                try {
                                    if (info.videoGid) {
                                        const vFiles = await rpc.call('getFiles', [info.videoGid]).catch(() => null);
                                        if (vFiles && vFiles.result && vFiles.result[0]) {
                                            const oldVUris = vFiles.result[0].uris.map(u => u.uri);
                                            await rpc.call('changeUri', [info.videoGid, 1, oldVUris, [videoUrl]]);
                                            await rpc.call('changeOption', [info.videoGid, {
                                                'user-agent': videoUA,
                                                header: videoHeaders
                                            }]).catch(() => {});
                                        }
                                        await rpc.call('unpause', [info.videoGid]).catch(() => {});
                                    }
                                    
                                    if (info.audioGid) {
                                        const aFiles = await rpc.call('getFiles', [info.audioGid]).catch(() => null);
                                        if (aFiles && aFiles.result && aFiles.result[0]) {
                                            const oldAUris = aFiles.result[0].uris.map(u => u.uri);
                                            await rpc.call('changeUri', [info.audioGid, 1, oldAUris, [audioUrl]]);
                                            await rpc.call('changeOption', [info.audioGid, {
                                                'user-agent': audioUA,
                                                header: audioHeaders
                                            }]).catch(() => {});
                                        }
                                        await rpc.call('unpause', [info.audioGid]).catch(() => {});
                                    }
                                    
                                    res.json({ success: true });
                                } catch (rpcErr) {
                                    console.error('[Resume] RPC error while updating URIs:', rpcErr);
                                    res.status(500).json({ error: 'Failed to update URIs in downloader.' });
                                }
                            } else {
                                res.status(500).json({ error: 'Invalid response from URL resolver.' });
                            }
                        } catch (parseErr) {
                            console.error('[Resume] Failed to parse JSON metadata:', parseErr);
                            res.status(500).json({ error: 'Failed to process metadata.' });
                        }
                    });
                    return;
                }
                
                if (info.videoGid) await rpc.call('unpause', [info.videoGid]).catch(() => {});
                if (info.audioGid) await rpc.call('unpause', [info.audioGid]).catch(() => {});
                res.json({ success: true });
            } else {
                await rpc.call('unpause', [gid]);
                res.json({ success: true });
            }
        } catch (e) {
            res.status(500).json({ error: e.message || 'Failed to resume download.' });
        }
    });

    return router;
};

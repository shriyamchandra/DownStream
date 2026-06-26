const express = require('express');
const fs = require('fs');
const path = require('path');

const ACTIVE_STATUSES = ['active', 'waiting', 'paused'];

// History endpoints: list, clear finished entries, delete (with optional file
// removal), and retry a failed/removed download from scratch.
module.exports = function historyRoutes({ rpc, history, config, pathGuard }) {
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
            if (ACTIVE_STATUSES.includes(item.status)) {
                await rpc.call('remove', [gid]);
            } else {
                await rpc.call('removeDownloadResult', [gid]);
            }
        } catch (e) {
            // Already removed or not in the active session.
        }

        if (deleteFile) {
            let filepaths = [];
            if (item.files && item.files.length > 0) {
                filepaths = item.files.map(f => f.path).filter(p => p);
            } else {
                filepaths.push(path.join(item.dir || config.data.downloadDir, item.filename));
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

    return router;
};

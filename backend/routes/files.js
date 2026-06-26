const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Video extensions allowed to be opened in a media player (keep in sync with the
// frontend's isVideoFile()).
const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mpg', 'mpeg', 'm2ts', 'mts', 'mxf', 'vob', 'ogv', 'rm', 'rmvb', 'divx', 'hevc', 'h264'];

// Recursively find a file by basename inside a directory (supports subfolders).
function findFile(dir, name) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            const found = findFile(fullPath, name);
            if (found) return found;
        } else if (file === name) {
            return fullPath;
        }
    }
    return null;
}

// File-related endpoints: stream to a player, delete, reveal in Finder, notify.
module.exports = function filesRoutes({ config, pathGuard, notifier }) {
    const router = express.Router();

    router.post('/api/stream', (req, res) => {
        const { filename, filepath: providedPath } = req.body;
        if (!filename && !providedPath) return res.status(400).json({ error: 'Filename or filepath required' });

        let filepath = null;

        // Prefer an explicit full path (avoids collisions on duplicate basenames).
        if (providedPath && pathGuard.isWithin(providedPath) && fs.existsSync(providedPath)) {
            filepath = providedPath;
        } else {
            const name = path.basename(filename || providedPath || '');
            if (!name) return res.status(400).json({ error: 'Filename required' });
            filepath = findFile(config.data.downloadDir, name);
        }

        if (!filepath) return res.status(404).json({ error: 'File not found on disk yet.' });

        // Only video files can be streamed to a media player.
        const ext = path.extname(filepath).toLowerCase().slice(1);
        if (!VIDEO_EXTS.includes(ext)) {
            return res.status(400).json({ error: 'Only video files can be streamed to a media player.' });
        }

        try {
            const stat = fs.statSync(filepath);
            if (stat.size < 200000) {
                // Still downloading (control file present) and under the buffer threshold.
                if (fs.existsSync(filepath + '.aria2')) {
                    return res.status(400).json({ error: 'Buffer not reached. File is < 200KB.' });
                }
            }
        } catch (e) {
            return res.status(500).json({ error: 'Could not read file size.' });
        }

        // Build argv for `open` (no shell) so a filename with shell metacharacters
        // (backticks, $(), quotes) can't inject commands.
        const openArgs = [];
        if (config.data.preferredPlayer === 'vlc') openArgs.push('-a', 'VLC');
        else if (config.data.preferredPlayer === 'iina') openArgs.push('-a', 'IINA');
        else if (config.data.preferredPlayer === 'mpv') openArgs.push('-a', 'mpv');
        openArgs.push(filepath);

        execFile('open', openArgs, (err) => {
            if (err) return res.status(500).json({ error: `Failed to launch ${config.data.preferredPlayer || 'default player'}.` });
            res.json({ success: true, message: 'Player launched!' });
        });
    });

    router.post('/api/delete', (req, res) => {
        const { filepath } = req.body;
        if (!filepath) return res.status(400).json({ error: 'Filepath required' });
        if (!pathGuard.isWithin(filepath)) {
            return res.status(403).json({ error: 'Path traversal blocked.' });
        }
        try {
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
            if (fs.existsSync(filepath + '.aria2')) fs.unlinkSync(filepath + '.aria2');
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Failed to delete files.' });
        }
    });

    router.post('/api/showInFinder', (req, res) => {
        const { filepath } = req.body;
        if (!filepath) return res.status(400).json({ error: 'Filepath required' });
        if (!pathGuard.isWithin(filepath)) {
            return res.status(403).json({ error: 'Path traversal blocked.' });
        }
        // open -R highlights the file in Finder (argv form, no shell).
        execFile('open', ['-R', filepath], (err) => {
            if (err) return res.status(500).json({ error: 'Failed to open in Finder.' });
            res.json({ success: true });
        });
    });

    router.post('/api/notify', (req, res) => {
        const { title, message } = req.body;
        if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
        notifier.notify(title, message);
        res.json({ success: true });
    });

    return router;
};

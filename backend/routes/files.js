const express = require('express');
const fs = require('fs');
const path = require('path');
const { VIDEO_EXTS, STREAM_BUFFER_THRESHOLD } = require('../shared-constants');
const { resolveStreamUrls } = require('../lib/ytDlpUtils');
const { launchPlayer, isUrlExpired, USER_AGENT } = require('../lib/playerLauncher');

function findFile(dir, name, depth = 0) {
    if (depth > 5) return null;
    try {
        if (!fs.existsSync(dir)) return null;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    const found = findFile(fullPath, name, depth + 1);
                    if (found) return found;
                } else if (file === name) {
                    return fullPath;
                }
            } catch (e) {}
        }
    } catch (e) {}
    return null;
}

module.exports = function filesRoutes({ config, pathGuard, notifier, streamUrlCache }) {
    const router = express.Router();

    router.post('/api/stream', (req, res) => {
        const { filename, filepath: providedPath, category, quality, url: srcUrlFromBody, formatId: formatIdFromBody } = req.body;
        if (quality) {
          console.log(`[Stream] Quality selected: ${quality}`);
          if (notifier) {
            notifier.notify('DownStream', `Streaming ${quality} quality...`);
          }
        }
        const formatId = formatIdFromBody || quality;
        const srcUrl = srcUrlFromBody || req.body.url;
        if (formatId && srcUrl) {
          const player = config.data.preferredPlayer !== undefined ? config.data.preferredPlayer : 'vlc';

          if (streamUrlCache) {
            const cacheKey = `${srcUrl}|${formatId || 'best'}`;
            const cached = formatId ? streamUrlCache.get(cacheKey) : (streamUrlCache.get(cacheKey) || streamUrlCache.get(srcUrl));
            if (cached) {
              if (isUrlExpired(cached.url) || (cached.audioUrl && isUrlExpired(cached.audioUrl))) {
                console.log(`[Stream API] Cache hit for key "${cacheKey}" is expired. Re-resolving.`);
              } else {
                console.log(`[Stream API] Cache hit for ${cacheKey}... — launching player instantly`);
                launchPlayer({
                  player,
                  targetUrl: cached.url,
                  audioUrl: cached.audioUrl,
                  originalUrl: srcUrl,
                  formatId,
                  streamUrlCache,
                  notifier,
                  title: srcUrl
                });
                return res.json({ success: true, message: `Stream launched (${formatId})` });
              }
            }
          }

          const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'yt-dlp') : '';
          const local = path.join(config.projectRoot, 'bin', 'yt-dlp');
          const ytdlp = (packaged && fs.existsSync(packaged)) ? packaged : local;
          
          resolveStreamUrls(ytdlp, config, srcUrl, formatId, USER_AGENT, config.data.youtubeCookiesBrowser)
            .then(({ videoFormatId, videoUrl, audioFormatId, audioUrl }) => {
              if (streamUrlCache) {
                const resolvedKey = `${srcUrl}|${videoFormatId}`;
                streamUrlCache.set(resolvedKey, { url: videoUrl, audioUrl });
                
                if (!formatId || videoFormatId === formatId || formatId === 'best' || ['4k','2160p','1080p','720p','480p'].includes(formatId)) {
                  const cacheKey = `${srcUrl}|${formatId || 'best'}`;
                  streamUrlCache.set(cacheKey, { url: videoUrl, audioUrl });
                }
              }
              launchPlayer({
                player,
                targetUrl: videoUrl,
                audioUrl,
                originalUrl: srcUrl,
                formatId,
                streamUrlCache,
                notifier,
                title: srcUrl
              });
              return res.json({ success: true, message: `Stream launched (${formatId})` });
            })
            .catch(err => {
              console.error('[Stream quality resolve] yt-dlp failed, falling back', err.message, err.stderr || '');
              launchPlayer({
                player,
                targetUrl: srcUrl,
                audioUrl: null,
                originalUrl: srcUrl,
                formatId,
                streamUrlCache,
                notifier,
                title: srcUrl
              });
              return res.json({ success: true, message: 'Stream launched (fallback to page URL)' });
            });
          return;
        }
        if (!filename && !providedPath) return res.status(400).json({ error: 'Filename or filepath required' });

        let filepath = null;

        if (providedPath && pathGuard.isWithin(providedPath) && fs.existsSync(providedPath)) {
            filepath = providedPath;
        } else {
            const name = path.basename(filename || providedPath || '');
            if (!name) return res.status(400).json({ error: 'Filename required' });

            if (category) {
                const categoryDir = path.join(config.data.downloadDir, category);
                const found = findFile(categoryDir, name);
                if (found && pathGuard.isWithin(found)) {
                    filepath = found;
                }
            }
            if (!filepath) {
                filepath = findFile(config.data.downloadDir, name);
            }
        }

        if (!filepath) return res.status(404).json({ error: 'File not found on disk yet.' });

        const ext = path.extname(filepath).toLowerCase().slice(1);
        if (!VIDEO_EXTS.includes(ext)) {
            return res.status(400).json({ error: 'Only video files can be streamed to a media player.' });
        }

        try {
            const stat = fs.statSync(filepath);
            if (stat.size < STREAM_BUFFER_THRESHOLD) {
                if (fs.existsSync(filepath + '.aria2')) {
                    return res.status(400).json({ error: `Buffer not reached. File is < ${STREAM_BUFFER_THRESHOLD / 1000}KB.` });
                }
            }
        } catch (e) {
            return res.status(500).json({ error: 'Could not read file size.' });
        }

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
        const { filepath: providedPath, filename, category } = req.body;
        if (!providedPath && !filename) return res.status(400).json({ error: 'Filepath or filename required' });

        let filepath = null;
        if (providedPath && pathGuard.isWithin(providedPath) && fs.existsSync(providedPath)) {
            filepath = providedPath;
        } else if (filename) {
            const name = path.basename(filename);
            if (category) {
                const categoryDir = path.join(config.data.downloadDir, category);
                const found = findFile(categoryDir, name);
                if (found && pathGuard.isWithin(found)) {
                    filepath = found;
                }
            }
            if (!filepath) {
                const found = findFile(config.data.downloadDir, name);
                if (found && pathGuard.isWithin(found)) {
                    filepath = found;
                }
            }
        }

        if (!filepath) return res.status(404).json({ error: 'File not found on disk.' });
        if (!pathGuard.isWithin(filepath)) {
            return res.status(403).json({ error: 'Path traversal blocked.' });
        }
        execFile('open', ['-R', filepath], (err) => {
            if (err) return res.status(500).json({ error: 'Failed to open in Finder.' });
            res.json({ success: true });
        });
    });

    router.post('/api/notify', (req, res) => {
        const { title, message } = req.body;
        if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
        if (notifier) notifier.notify(title, message);
        res.json({ success: true });
    });

    return router;
};

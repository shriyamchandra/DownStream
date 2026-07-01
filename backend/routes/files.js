const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');
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

    function isYouTubeUrl(urlStr) {
        try {
            const host = new URL(urlStr).hostname.toLowerCase();
            return host.includes('youtube.com') || host.includes('youtu.be');
        } catch (e) { return false; }
    }

    function getYtDlpPath() {
        const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'yt-dlp') : '';
        const local = path.join(config.projectRoot, 'bin', 'yt-dlp');
        return (packaged && fs.existsSync(packaged)) ? packaged : local;
    }

    // Pre-resolve stream URLs for common formats in the background
    // so /api/stream can serve from cache instantly
    function preWarmStreamCache(srcUrl, formats) {
        if (!streamUrlCache || !srcUrl || !isYouTubeUrl(srcUrl)) return;
        const ytdlp = getYtDlpPath();
        const formatsToResolve = ['best', '1080p', '720p'];

        for (const fmt of formatsToResolve) {
            const cacheKey = `${srcUrl}|${fmt}`;
            if (streamUrlCache.has(cacheKey)) continue;

            resolveStreamUrls(ytdlp, config, srcUrl, fmt, USER_AGENT, null)
                .then(({ videoFormatId, videoUrl, audioUrl }) => {
                    const resolvedKey = `${srcUrl}|${videoFormatId}`;
                    streamUrlCache.set(resolvedKey, { url: videoUrl, audioUrl });
                    streamUrlCache.set(cacheKey, { url: videoUrl, audioUrl });
                    console.log(`[Stream] Pre-warmed cache for ${fmt}`);
                })
                .catch(() => {}); // silent — this is a background optimization
        }
    }

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

        const player = config.data.preferredPlayer !== undefined ? config.data.preferredPlayer : 'vlc';

        // FIRST: Check if the file is already downloaded locally
        let localFilepath = null;
        if (providedPath && pathGuard.isWithin(providedPath) && fs.existsSync(providedPath)) {
            localFilepath = providedPath;
        } else if (filename) {
            const name = path.basename(filename);
            if (name) {
                if (category) {
                    const categoryDir = path.join(config.data.downloadDir, category);
                    const found = findFile(categoryDir, name);
                    if (found && pathGuard.isWithin(found)) localFilepath = found;
                }
                if (!localFilepath) {
                    const found = findFile(config.data.downloadDir, name);
                    if (found && pathGuard.isWithin(found)) localFilepath = found;
                }
            }
        }

        // If file exists locally, play it directly — no network needed
        if (localFilepath) {
            const ext = path.extname(localFilepath).toLowerCase().slice(1);
            if (VIDEO_EXTS.includes(ext)) {
                console.log(`[Stream] Playing local file: ${localFilepath}`);
                if (player === 'mpv') {
                    const mpvPath = ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv'].find(p => fs.existsSync(p)) || 'mpv';
                    execFile(mpvPath, [localFilepath], (err) => {
                        if (err) return res.status(500).json({ error: 'Failed to launch mpv.' });
                        return res.json({ success: true, message: 'Player launched (local file)' });
                    });
                    setTimeout(() => { try { exec(`osascript -e 'tell application "mpv" to activate'`, () => {}); } catch(e) {} }, 500);
                    return;
                } else if (player === 'iina') {
                    const iinaPath = ['/Applications/IINA.app/Contents/MacOS/iina-cli',
                                     path.join(require('os').homedir(), 'Applications/IINA.app/Contents/MacOS/iina-cli')
                                    ].find(p => fs.existsSync(p)) || 'iina-cli';
                    execFile(iinaPath, [localFilepath], (err) => {
                        if (err) return res.status(500).json({ error: 'Failed to launch IINA.' });
                        return res.json({ success: true, message: 'Player launched (local file)' });
                    });
                    setTimeout(() => { try { exec(`osascript -e 'tell application "IINA" to activate'`, () => {}); } catch(e) {} }, 500);
                    return;
                } else {
                    const openArgs = player === 'vlc' ? ['-a', 'VLC', localFilepath] : [localFilepath];
                    execFile('open', openArgs, (err) => {
                        if (err) return res.status(500).json({ error: `Failed to launch ${player || 'default player'}.` });
                        return res.json({ success: true, message: 'Player launched (local file)' });
                    });
                    setTimeout(() => { try { exec(`osascript -e 'tell application "VLC" to activate'`, () => {}); } catch(e) {} }, 500);
                    return;
                }
            }
        }

        // No local file found — resolve via yt-dlp for YouTube URLs
        if (srcUrl && isYouTubeUrl(srcUrl)) {
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
                  formatId: formatId || 'best',
                  streamUrlCache,
                  notifier,
                  title: filename || srcUrl
                });
                return res.json({ success: true, message: 'Stream launched' });
              }
            }
          }

          const ytdlp = getYtDlpPath();
          if (notifier) notifier.notify('DownStream', `Resolving stream for: ${(filename || '').substring(0, 45)}...`);

          resolveStreamUrls(ytdlp, config, srcUrl, formatId || 'best', USER_AGENT, null)
            .then(({ videoFormatId, videoUrl, audioFormatId, audioUrl }) => {
              if (streamUrlCache) {
                const resolvedKey = `${srcUrl}|${videoFormatId}`;
                streamUrlCache.set(resolvedKey, { url: videoUrl, audioUrl });
                const cacheKey = `${srcUrl}|${formatId || 'best'}`;
                streamUrlCache.set(cacheKey, { url: videoUrl, audioUrl });
              }
              launchPlayer({
                player,
                targetUrl: videoUrl,
                audioUrl,
                originalUrl: srcUrl,
                formatId: formatId || 'best',
                streamUrlCache,
                notifier,
                title: filename || srcUrl
              });
              return res.json({ success: true, message: 'Stream launched' });
            })
            .catch(err => {
              console.error('[Stream] yt-dlp failed, falling back to page URL:', err.message, err.stderr || '');
              launchPlayer({
                player,
                targetUrl: srcUrl,
                audioUrl: null,
                originalUrl: srcUrl,
                formatId: formatId || 'best',
                streamUrlCache,
                notifier,
                title: filename || srcUrl
              });
              return res.json({ success: true, message: 'Stream launched (fallback)' });
            });
          return;
        }

        // Non-YouTube path with explicit formatId + URL
        if (formatId && srcUrl) {
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

          const ytdlp = getYtDlpPath();
          // Skip cookies for streaming to avoid Keychain prompts
          resolveStreamUrls(ytdlp, config, srcUrl, formatId, USER_AGENT, null)
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

        let openArgs;
        if (player === 'mpv') {
            const mpvPath = ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv'].find(p => fs.existsSync(p)) || 'mpv';
            execFile(mpvPath, [filepath], (err) => {
                if (err) return res.status(500).json({ error: 'Failed to launch mpv.' });
                res.json({ success: true, message: 'Player launched!' });
            });
            setTimeout(() => { try { exec(`osascript -e 'tell application "mpv" to activate'`, () => {}); } catch(e) {} }, 500);
            return;
        } else if (player === 'iina') {
            const iinaPath = ['/Applications/IINA.app/Contents/MacOS/iina-cli',
                             path.join(require('os').homedir(), 'Applications/IINA.app/Contents/MacOS/iina-cli')
                            ].find(p => fs.existsSync(p)) || 'iina-cli';
            execFile(iinaPath, [filepath], (err) => {
                if (err) return res.status(500).json({ error: 'Failed to launch IINA.' });
                res.json({ success: true, message: 'Player launched!' });
            });
            setTimeout(() => { try { exec(`osascript -e 'tell application "IINA" to activate'`, () => {}); } catch(e) {} }, 500);
            return;
        } else {
            openArgs = player === 'vlc' ? ['-a', 'VLC', filepath] : [filepath];
        }

        execFile('open', openArgs, (err) => {
            if (err) return res.status(500).json({ error: `Failed to launch ${player || 'default player'}.` });
            res.json({ success: true, message: 'Player launched!' });
        });
        setTimeout(() => { try { exec(`osascript -e 'tell application "VLC" to activate'`, () => {}); } catch(e) {} }, 500);
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

    router.preWarmStreamCache = preWarmStreamCache;
    return router;
};

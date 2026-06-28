const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { VIDEO_EXTS, STREAM_BUFFER_THRESHOLD } = require('../shared-constants');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const { resolveStreamUrls } = require('../lib/ytDlpUtils');

// Recursively find a file by basename inside a directory (supports subfolders).
// Includes try/catch to prevent crashes on unreadable folders and a depth limit.
function findFile(dir, name, depth = 0) {
    if (depth > 5) return null; // limit recursion depth
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
            } catch (e) {
                // Ignore read/stat error for this specific file/folder and continue
            }
        }
    } catch (e) {
        // Ignore read/permission error for this directory
    }
    return null;
}

// File-related endpoints: stream to a player, delete, reveal in Finder, notify.
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
        // Support quality selection by resolving stream URL via yt-dlp when a source url is provided (e.g. youtube watch url)
        const formatId = formatIdFromBody || quality;
        const srcUrl = srcUrlFromBody || req.body.url;
        if (formatId && srcUrl) {
          const player = config.data.preferredPlayer || 'vlc';
          const launchPlayer = (targetUrl, audioUrl = null, originalUrl = null, formatId = null) => {
              let bin, args;

              // For IINA and mpv, playing split streams (with audioUrl) or default "best" via the watch URL directly 
              // is highly robust because the player resolves and plays both video and audio tracks natively via its internal yt-dlp.
              const useYtdlWatchUrl = (player === 'iina' || player === 'mpv') && originalUrl && (audioUrl || !formatId || formatId === 'best');

              if (useYtdlWatchUrl) {
                  if (player === 'iina') {
                      bin = '/Applications/IINA.app/Contents/MacOS/iina-cli';
                      args = [originalUrl, '--'];
                      if (formatId && formatId !== 'best') {
                          args.push(`--ytdl-format=${formatId}+bestaudio/best`);
                      }
                  } else { // mpv
                      bin = '/usr/local/bin/mpv';
                      args = [originalUrl];
                      if (formatId && formatId !== 'best') {
                          args.push(`--ytdl-format=${formatId}+bestaudio/best`);
                      }
                  }
              } else {
                  // Otherwise, play the resolved progressive CDN URL directly
                  if (player === 'iina') {
                      bin = '/Applications/IINA.app/Contents/MacOS/iina-cli';
                      args = [targetUrl, '--', `--user-agent=${USER_AGENT}`];
                  } else if (player === 'mpv') {
                      bin = '/usr/local/bin/mpv';
                      args = [targetUrl, `--user-agent=${USER_AGENT}`];
                  } else if (player === 'vlc') {
                      bin = '/Applications/VLC.app/Contents/MacOS/VLC';
                      let playUrl = targetUrl;
                      // Fall back to a progressive format URL from cache if available.
                      if (audioUrl && originalUrl) {
                          const progCached = streamUrlCache ? streamUrlCache.get(`${originalUrl}|progressive`) : null;
                          if (progCached && progCached.url) {
                              playUrl = progCached.url;
                              console.log('[VLC Fallback API] Using progressive stream for VLC playback:', playUrl.substring(0, 60));
                          }
                      }
                      if (audioUrl && playUrl === targetUrl) {
                          args = [targetUrl, `--input-slave=${audioUrl}`, `--http-user-agent=${USER_AGENT}`];
                      } else {
                          args = [playUrl, `--http-user-agent=${USER_AGENT}`];
                      }
                  } else {
                      bin = 'open';
                      args = [targetUrl];
                  }
              }

              console.log(`[Stream Launch API] ${player}: ${bin}`, JSON.stringify(args.map(a => a.length > 80 ? a.substring(0, 77) + '...' : a)));
              execFile(bin, args, (err) => {
                  if (err) console.error(`[Stream Launch API] Failed: ${err.message}`);
              });
          };

          // Check cache first
          if (streamUrlCache) {
            const cacheKey = `${srcUrl}|${formatId || 'best'}`;
            const cached = formatId ? streamUrlCache.get(cacheKey) : (streamUrlCache.get(cacheKey) || streamUrlCache.get(srcUrl));
            if (cached) {
              console.log(`[Stream API] Cache hit for ${cacheKey}... — launching player instantly`);
              launchPlayer(cached.url, cached.audioUrl, srcUrl, formatId);
              return res.json({ success: true, message: `Stream launched (${formatId})` });
            }
          }

          const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'yt-dlp') : '';
          const local = path.join(config.projectRoot, 'bin', 'yt-dlp');
          const ytdlp = (packaged && fs.existsSync(packaged)) ? packaged : local;
          
          resolveStreamUrls(ytdlp, config, srcUrl, formatId, USER_AGENT, config.data.youtubeCookiesBrowser)
            .then(({ videoFormatId, videoUrl, audioFormatId, audioUrl }) => {
              if (streamUrlCache) {
                // Cache under actual resolved formats
                const resolvedKey = `${srcUrl}|${videoFormatId}`;
                streamUrlCache.set(resolvedKey, { url: videoUrl, audioUrl });
                
                // Cache under requested key if appropriate
                if (!formatId || videoFormatId === formatId || formatId === 'best' || ['4k','2160p','1080p','720p','480p'].includes(formatId)) {
                  const cacheKey = `${srcUrl}|${formatId || 'best'}`;
                  streamUrlCache.set(cacheKey, { url: videoUrl, audioUrl });
                }
              }
              launchPlayer(videoUrl, audioUrl, srcUrl, formatId);
              return res.json({ success: true, message: `Stream launched (${formatId})` });
            })
            .catch(err => {
              console.error('[Stream quality resolve] yt-dlp failed, falling back', err.message, err.stderr || '');
              launchPlayer(srcUrl, null, srcUrl, formatId);
              return res.json({ success: true, message: 'Stream launched (fallback to page URL)' });
            });
          return;
        }
        if (!filename && !providedPath) return res.status(400).json({ error: 'Filename or filepath required' });

        let filepath = null;

        // Prefer an explicit full path (avoids collisions on duplicate basenames).
        if (providedPath && pathGuard.isWithin(providedPath) && fs.existsSync(providedPath)) {
            filepath = providedPath;
        } else {
            const name = path.basename(filename || providedPath || '');
            if (!name) return res.status(400).json({ error: 'Filename required' });

            // Prioritize searching the category subfolder first to avoid duplicate filename collisions
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

        // Only video files can be streamed to a media player.
        const ext = path.extname(filepath).toLowerCase().slice(1);
        if (!VIDEO_EXTS.includes(ext)) {
            return res.status(400).json({ error: 'Only video files can be streamed to a media player.' });
        }

        try {
            const stat = fs.statSync(filepath);
            if (stat.size < STREAM_BUFFER_THRESHOLD) {
                // Still downloading (control file present) and under the buffer threshold.
                if (fs.existsSync(filepath + '.aria2')) {
                    return res.status(400).json({ error: `Buffer not reached. File is < ${STREAM_BUFFER_THRESHOLD / 1000}KB.` });
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
        // open -R highlights the file in Finder (argv form, no shell).
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

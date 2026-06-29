const express = require('express');
const path = require('path');
const EventEmitter = require('events');
const fs = require('fs');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const createConfig = require('./config');
const createRpcClient = require('./aria2/rpcClient');
const createProcessManager = require('./aria2/processManager');
const createHistoryStore = require('./history/historyStore');
const createSyncService = require('./history/syncService');
const createPathGuard = require('./lib/pathGuard');
const notifier = require('./lib/notifier');
const { cors, requestLogger } = require('./middleware/httpGuards');
const StreamUrlCache = require('./lib/streamUrlCache');
const { findNodeRuntime, execYtDlpJson, resolveStreamUrls, parseYtDlpProgress } = require('./lib/ytDlpUtils');

const settingsRoutes = require('./routes/settings');
const filesRoutes = require('./routes/files');
const historyRoutes = require('./routes/history');
const interceptRoutes = require('./routes/intercept');
const createInterceptor = require('./lib/interceptor');

// ── Composition root ──────────────────────────────────────────
// Build each single-responsibility piece and inject its collaborators. Nothing
// below reaches into another module's internals — they depend on the small
// { call } / { notify } / { isWithin } / { items, save } interfaces only.
const events = new EventEmitter();
const config = createConfig();
const pathGuard = createPathGuard(config);
const rpc = createRpcClient({ port: config.aria2Port });
const history = createHistoryStore(config);
const activeMerges = new Map();
const mergesFilePath = path.join(config.projectRoot, 'active-merges.json');
const streamUrlCache = new StreamUrlCache(50 * 1000);

async function loadActiveMerges() {
    try {
        if (fs.existsSync(mergesFilePath)) {
            const fileData = await fs.promises.readFile(mergesFilePath, 'utf8');
            const data = JSON.parse(fileData);
            let valid = 0, skipped = 0;
            for (const [k, v] of Object.entries(data)) {
                // Reject entries from old formats missing required fields
                if (!v.mergedGid || !v.videoGid || !v.audioGid || !v.finalName) {
                    skipped++;
                    continue;
                }
                activeMerges.set(k, v);
                valid++;
            }
            if (skipped > 0) {
                console.log(`[ActiveMerges] Loaded ${valid} entries, skipped ${skipped} stale/invalid entries`);
                await saveActiveMerges(); // Persist the cleaned-up state
            }
        }
    } catch (e) {
        console.error('Failed to load active merges:', e);
    }
}

async function saveActiveMerges() {
    try {
        const obj = Object.fromEntries(activeMerges.entries());
        await fs.promises.writeFile(mergesFilePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save active merges:', e);
    }
}

const activeYoutubeDownloads = new Map();


const reservedFilenames = new Set();

function getUniqueFilename(dir, baseName) {
    let finalPath = path.join(dir, baseName);
    const ext = path.extname(baseName);
    const stem = baseName.slice(0, baseName.length - ext.length);
    let counter = 1;
    
    while (true) {
        if (reservedFilenames.has(finalPath)) {
            const candidate = `${stem} (${counter})${ext}`;
            finalPath = path.join(dir, candidate);
            counter++;
            continue;
        }
        
        try {
            // Attempt to atomically reserve the name on disk
            const fd = fs.openSync(finalPath, 'wx');
            fs.closeSync(fd);
            reservedFilenames.add(finalPath);
            return finalPath;
        } catch (err) {
            if (err.code === 'EEXIST') {
                const candidate = `${stem} (${counter})${ext}`;
                finalPath = path.join(dir, candidate);
                counter++;
            } else {
                throw err;
            }
        }
    }
}

function startYoutubeDownload(gid, url, filename, formatId, chosenExt, referrer) {
    const item = history.items.find(x => x.gid === gid);
    if (!item) return;

    // `filename` arrives WITH the extension (e.g. "My Video.mp4").
    // Strip it to get a clean stem for the output template.
    const ext = chosenExt || 'mp4';
    const currentExt = path.extname(filename);          // ".mp4"
    const stem = currentExt ? filename.slice(0, -currentExt.length) : filename;  // "My Video"

    const packagedYtDlp = process.resourcesPath ? path.join(process.resourcesPath, 'yt-dlp') : '';
    const localYtDlp = path.join(config.projectRoot, 'bin', 'yt-dlp');
    const ytDlpPath = (packagedYtDlp && fs.existsSync(packagedYtDlp)) ? packagedYtDlp : localYtDlp;

    const ffmpegStatic = require('ffmpeg-static');

    const { AUDIO_EXTS } = require('./shared-constants');
    const isAudio = AUDIO_EXTS.includes(ext);

    let formatSpec;
    if (isAudio) {
        formatSpec = formatId ? formatId : 'bestaudio/best';
    } else {
        formatSpec = formatId ? `${formatId}+ba/best` : 'bestvideo+bestaudio/best';
    }

    // Output template: use the stem + unique gid + .temp-yt. prefix before yt-dlp's own %(ext)s.
    const outputTemplate = path.join(config.data.downloadDir, `${stem}.${gid}.temp-yt.%(ext)s`);

    const args = [
        '--ignore-config',
        '--no-warnings',
        '--no-playlist',
        '--progress',
        '-o', outputTemplate,
        '-c'
    ];
    if (referrer) {
        args.push('--referer', referrer);
    }
    if (config.appDataDir) {
        args.push('--cache-dir', path.join(config.appDataDir, 'yt-dlp-cache'));
    }

    const runtime = findNodeRuntime(config);
    if (runtime) {
        args.push('--js-runtimes', `node:${runtime}`);
    }
    args.push('--ffmpeg-location', ffmpegStatic);

    if (config.data.youtubeCookiesBrowser) {
        args.push('--cookies-from-browser', config.data.youtubeCookiesBrowser);
    }

    if (isAudio) {
        args.push('-f', formatSpec);
        args.push('-x', '--audio-format', ext);
    } else {
        args.push('-f', formatSpec);
        args.push('--merge-output-format', ext);
    }
    args.push(url);

    console.log(`[YouTube Download] Spawning for GID ${gid}: ${ytDlpPath} ${args.join(' ')}`);
    const { spawn } = require('child_process');
    const proc = spawn(ytDlpPath, args);
    
    const activeInfo = {
        process: proc,
        isPausedIntentionally: false,
        url,
        filename,
        formatId,
        chosenExt
    };
    activeYoutubeDownloads.set(gid, activeInfo);

    let lastProgressTime = Date.now();
    let currentStream = isAudio ? 'audio' : 'video';
    let videoTotalBytes = 0;
    let videoCompletedBytes = 0;
    let destinationCount = 0;

    let lineBuffer = '';
    proc.stdout.on('data', (data) => {
        lineBuffer += data.toString();
        const parts = lineBuffer.split(/[\r\n]+/);
        lineBuffer = parts.pop();

        for (const line of parts) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.includes('[ffmpeg] Merging formats') || trimmed.includes('[Merger] Merging formats')) {
                item.status = 'merging';
                item.downloadSpeed = 0;
                history.save();
                continue;
            }
            const progress = parseYtDlpProgress(trimmed);
            if (progress) {
                if (progress.isDestination) {
                    destinationCount++;
                    if (destinationCount > 1 && currentStream === 'video') {
                        currentStream = 'audio';
                        videoCompletedBytes = videoTotalBytes;
                    }
                    continue;
                }
                const now = Date.now();
                if (currentStream === 'video') {
                    videoTotalBytes = progress.totalLength;
                    videoCompletedBytes = progress.completedLength;
                    item.completedLength = progress.completedLength;
                    item.totalLength = progress.totalLength;
                } else {
                    item.completedLength = videoCompletedBytes + progress.completedLength;
                    item.totalLength = videoTotalBytes + progress.totalLength;
                }
                item.downloadSpeed = progress.downloadSpeed;
                item.status = 'active';
                item.phase = currentStream;

                if (now - lastProgressTime > 1500) {
                    history.save();
                    lastProgressTime = now;
                }
            }
        }
    });

    let stderrBuffer = '';
    proc.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
        const parts = stderrBuffer.split(/[\r\n]+/);
        stderrBuffer = parts.pop();

        for (const line of parts) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            console.warn(`[YouTube Download ${gid} Stderr]:`, trimmed);
            if (trimmed.includes('[ffmpeg] Merging formats') || trimmed.includes('[Merger] Merging formats')) {
                item.status = 'merging';
                item.downloadSpeed = 0;
                history.save();
            }
        }
    });

    proc.on('close', (code) => {
        activeYoutubeDownloads.delete(gid);
        
        if (activeInfo.isPausedIntentionally) {
            console.log(`[YouTube Download ${gid}] Exited due to pause.`);
            return;
        }

        if (code === 0) {
            console.log(`[YouTube Download ${gid}] Completed successfully.`);
            
            // The final filename the user expects (e.g. "My Video.mp4")
            const finalName = `${stem}.${ext}`;
            
            // yt-dlp should have produced "stem.gid.temp-yt.ext" after merge
            const expectedTemp = path.join(config.data.downloadDir, `${stem}.${gid}.temp-yt.${ext}`);
            let tempPath = null;

            if (fs.existsSync(expectedTemp)) {
                tempPath = expectedTemp;
            } else {
                // Glob for stem.gid.temp-yt.* files
                try {
                    const dirFiles = fs.readdirSync(config.data.downloadDir);
                    const prefix = `${stem}.${gid}.temp-yt.`;
                    const match = dirFiles.find(f => f.startsWith(prefix));
                    if (match) {
                        tempPath = path.join(config.data.downloadDir, match);
                    }
                } catch (e) {
                    console.error(`[YouTube Download ${gid}] Failed to scan download dir:`, e);
                }
            }

            if (tempPath) {
                let finalPath = null;
                try {
                    const actualExt = path.extname(tempPath).slice(1) || ext;
                    const finalNameWithActualExt = `${stem}.${actualExt}`;
                    finalPath = getUniqueFilename(config.data.downloadDir, finalNameWithActualExt);
                    const actualFinalName = path.basename(finalPath);

                    fs.renameSync(tempPath, finalPath);
                    console.log(`[YouTube Download ${gid}] Renamed "${path.basename(tempPath)}" -> "${actualFinalName}"`);
                    
                    const stats = fs.statSync(finalPath);
                    item.status = 'complete';
                    item.totalLength = stats.size;
                    item.completedLength = stats.size;
                    item.downloadSpeed = 0;
                    item.completedDate = new Date().toISOString();
                    item.files = [{ path: finalPath }];
                    item.filename = actualFinalName;
                    history.save();
                    
                    if (notifier) {
                        notifier.notify('DownStream', `Download completed: ${actualFinalName}`);
                    }
                } catch (err) {
                    console.error(`[YouTube Download ${gid}] Failed to rename output:`, err);
                    if (finalPath && fs.existsSync(finalPath)) {
                        try { fs.unlinkSync(finalPath); } catch (e) {}
                    }
                    item.status = 'error';
                    item.downloadSpeed = 0;
                    item.errorMessage = `Failed to rename output: ${err.message}`;
                    history.save();
                } finally {
                    if (finalPath) {
                        reservedFilenames.delete(finalPath);
                    }
                }
            } else {
                console.warn(`[YouTube Download ${gid}] No temp file found to rename. File may already be at final path.`);
                
                let finalPath = path.join(config.data.downloadDir, `${stem}.${ext}`);
                let finalSize = item.totalLength;
                if (fs.existsSync(finalPath)) {
                    try {
                        finalSize = fs.statSync(finalPath).size;
                    } catch (e) {}
                }

                item.status = 'complete';
                item.totalLength = finalSize;
                item.completedLength = finalSize;
                item.downloadSpeed = 0;
                item.completedDate = new Date().toISOString();
                history.save();
            }
        } else {
            console.error(`[YouTube Download ${gid}] Failed with exit code: ${code}`);
            item.status = 'error';
            item.downloadSpeed = 0;
            item.errorMessage = `Download process exited with code ${code}`;
            history.save();
            
            if (notifier) {
                notifier.notify('DownStream', `Download failed: ${filename}`);
            }
        }
    });
}

// Pause any active/waiting YouTube downloads on startup
if (history && history.items) {
    let startupCleaned = false;
    history.items.forEach(item => {
        if (item.gid && item.gid.startsWith('youtube-') && (item.status === 'active' || item.status === 'waiting')) {
            item.status = 'paused';
            item.downloadSpeed = 0;
            startupCleaned = true;
        }
    });
    if (startupCleaned) history.save();
}

loadActiveMerges();

const processManager = createProcessManager(config);
const sync = createSyncService({ rpc, history, config, activeMerges, saveActiveMerges, notifier });

// Free ports + launch the aria2c engine before we start serving.
processManager.start();

const app = express();
app.use(express.json());
// Static assets are served before the origin guard so the UI loads normally;
// only the /api/* surface is gated by CORS.
app.use(express.static(path.join(config.projectRoot, 'frontend')));
app.use(cors);
app.use(requestLogger);

const { execFile } = require('child_process');


const qualitiesRateLimit = new Map();
let concurrentQualitiesCount = 0;
const MAX_CONCURRENT_QUALITIES = 3;

app.post('/api/qualities', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const lastRequestTime = qualitiesRateLimit.get(ip) || 0;
        if (now - lastRequestTime < 2000) {
            return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
        }
        qualitiesRateLimit.set(ip, now);

        if (concurrentQualitiesCount >= MAX_CONCURRENT_QUALITIES) {
            return res.status(429).json({ error: 'Server is busy resolving qualities. Please try again in a few seconds.' });
        }

        concurrentQualitiesCount++;
        
        const packagedYtDlp = process.resourcesPath ? path.join(process.resourcesPath, 'yt-dlp') : '';
        const localYtDlp = path.join(config.projectRoot, 'bin', 'yt-dlp');
        const ytDlpPath = (packagedYtDlp && fs.existsSync(packagedYtDlp)) ? packagedYtDlp : localYtDlp;
        
        const ytDlpArgs = [
            '--ignore-config',
            '--no-warnings',
            '-J',
            '--no-playlist',
            '--no-check-formats',
            '--user-agent', USER_AGENT
        ];
        if (config.appDataDir) {
            ytDlpArgs.push('--cache-dir', path.join(config.appDataDir, 'yt-dlp-cache'));
        }
        const runtime = findNodeRuntime(config);
        if (runtime) {
            ytDlpArgs.push('--js-runtimes', `node:${runtime}`);
        }
        if (config.data.youtubeCookiesBrowser) {
            ytDlpArgs.push('--cookies-from-browser', config.data.youtubeCookiesBrowser);
        }
        ytDlpArgs.push(url);

        execYtDlpJson(ytDlpPath, ytDlpArgs)
            .then(({ json, stderr }) => {
                concurrentQualitiesCount = Math.max(0, concurrentQualitiesCount - 1);
                const info = json;
                if (!info || !Array.isArray(info.formats)) {
                    return res.json({ success: true, formats: { progressive: [], videoOnly: [], audioOnly: [] } });
                }

                const formatSize = (bytes) => {
                    if (!bytes) return 'Unknown size';
                    const kb = bytes / 1024;
                    const mb = kb / 1024;
                    if (mb >= 1024) {
                        return `${(mb / 1024).toFixed(1)} GB`;
                    }
                    return `${mb.toFixed(1)} MB`;
                };

                const formatsList = info.formats.map(f => {
                    const hasVideo = f.vcodec && f.vcodec !== 'none';
                    const hasAudio = f.acodec && f.acodec !== 'none';
                    
                    return {
                        formatId: f.format_id,
                        ext: f.ext || 'mp4',
                        resolution: f.resolution || (f.width && f.height ? `${f.width}x${f.height}` : null) || (f.height ? `${f.height}p` : 'Unknown'),
                        height: f.height || 0,
                        filesize: f.filesize || f.filesize_approx || null,
                        filesizeStr: formatSize(f.filesize || f.filesize_approx),
                        fps: f.fps || null,
                        hasVideo,
                        hasAudio,
                        protocol: f.protocol || ''
                    };
                });

                const progressive = formatsList
                    .filter(f => f.hasVideo && f.hasAudio && f.protocol.startsWith('http'))
                    .sort((a, b) => b.height - a.height);

                const videoOnly = formatsList
                    .filter(f => f.hasVideo && !f.hasAudio && f.protocol.startsWith('http'))
                    .sort((a, b) => b.height - a.height);

                const audioOnly = formatsList
                    .filter(f => !f.hasVideo && f.hasAudio && f.protocol.startsWith('http'))
                    .sort((a, b) => (b.filesize || 0) - (a.filesize || 0));

                // Cache the best streamable URL for instant VLC playback
                try {
                    // Find the best audio format first
                    const bestAudio = info.formats
                        .filter(f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none' && f.url && typeof f.protocol === 'string' && f.protocol.startsWith('http'))
                        .sort((a, b) => (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0))[0];

                    // Find the absolute best video format
                    const bestVideo = info.formats
                        .filter(f => f.vcodec && f.vcodec !== 'none' && f.url && typeof f.protocol === 'string' && f.protocol.startsWith('http'))
                        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

                    // Find the best progressive format
                    const bestProgressive = info.formats
                        .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.url && typeof f.protocol === 'string' && f.protocol.startsWith('http'))
                        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

                    if (bestProgressive) {
                        streamUrlCache.set(`${url}|progressive`, {
                            url: bestProgressive.url,
                            audioUrl: null
                        });
                        console.log(`[Qualities] Cached progressive fallback: ${bestProgressive.height}p`);
                    }

                    if (bestVideo) {
                        const hasAudio = bestVideo.acodec && bestVideo.acodec !== 'none';
                        const bestObj = {
                            url: bestVideo.url,
                            audioUrl: hasAudio ? null : (bestAudio ? bestAudio.url : null)
                        };
                        streamUrlCache.set(`${url}|best`, bestObj);
                        streamUrlCache.set(url, bestObj);
                        console.log(`[Qualities] Cached 'best' stream URL (Height: ${bestVideo.height}p, HasAudio: ${hasAudio})`);
                    }

                    // Cache each format specifically by formatId (including split formats)
                    info.formats.forEach(f => {
                        if (f.vcodec && f.vcodec !== 'none' && f.url && typeof f.protocol === 'string' && f.protocol.startsWith('http')) {
                            const hasAudio = f.acodec && f.acodec !== 'none';
                            streamUrlCache.set(`${url}|${f.format_id}`, {
                                url: f.url,
                                audioUrl: hasAudio ? null : (bestAudio ? bestAudio.url : null)
                            });
                        }
                    });
                } catch (cacheErr) {
                    console.warn('[Qualities] Failed to cache stream URL:', cacheErr.message);
                }

                res.json({
                    success: true,
                    title: info.title || 'Video Title',
                    formats: {
                        progressive,
                        videoOnly,
                        audioOnly
                    }
                });
            })
            .catch(err => {
                concurrentQualitiesCount = Math.max(0, concurrentQualitiesCount - 1);
                console.error('[yt-dlp qualities] Failed to fetch qualities:', err.message, err.stderr || '');
                return res.status(500).json({ error: 'Failed to extract video qualities: ' + err.message });
            });
    } catch (e) {
        console.error('[api/qualities] Error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.get('/api/ping', (req, res) => {
    res.json({ success: true, webPort: config.webPort });
});

let ariaReady = false;
const pendingIntercepts = [];

const handleIntercept = createInterceptor({
    config,
    rpc,
    history,
    notifier,
    events,
    streamUrlCache,
    startYoutubeDownload,
    getAriaReady: () => ariaReady,
    queuePendingIntercept: (data) => pendingIntercepts.push(data)
});

app.use(settingsRoutes({ config }));
app.use(filesRoutes({ config, pathGuard, notifier, streamUrlCache }));
app.use(historyRoutes({ rpc, history, config, pathGuard, activeMerges, saveActiveMerges, activeYoutubeDownloads, startYoutubeDownload }));
app.use(interceptRoutes({ rpc, notifier, events, handleIntercept }));

app.get('/api/active-merges', (req, res) => {
    res.json(Object.fromEntries(activeMerges.entries()));
});

async function ensureAriaReady(maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await rpc.call('getVersion', []);
      if (res && !res.error) {
        ariaReady = true;
        drainPendingIntercepts();
        return;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 600));
  }
  console.error('[Aria2] Port 6800 not responding, giving up.');
}

async function drainPendingIntercepts() {
  while (pendingIntercepts.length > 0) {
    const item = pendingIntercepts.shift();
    try {
      await handleIntercept(item);
    } catch (e) {
      console.error('[Aria2] Failed to process delayed intercept:', e.message);
    }
  }
}

// Start checking in the background
ensureAriaReady();

let syncInterval = null;

function startSync(intervalMs = 2500) {
    if (!syncInterval) {
        syncInterval = sync.start(intervalMs);
    }
}

function stopSync() {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
}

// Periodic aria2 <-> history reconciliation.
startSync(2500);

app.listen(config.webPort, () => {
    console.log(`\n============================================`);
    console.log(`🚀 DownStream Web Manager is running!`);
    console.log(`👉 Open your browser to: http://localhost:${config.webPort}`);
    console.log(`============================================\n`);
});

// ── Shutdown ──────────────────────────────────────────────────
function cleanup() {
    console.log('[Cleanup] Killing active YouTube downloads...');
    for (const [gid, info] of activeYoutubeDownloads) {
        if (info.process) {
            info.isPausedIntentionally = true;
            try {
                info.process.kill('SIGTERM');
            } catch (err) {
                console.error(`Failed to kill download ${gid}:`, err);
            }
        }
    }
    processManager.cleanup();
}

process.on('SIGINT', () => { cleanup(); process.exit(); });
process.on('SIGTERM', () => { cleanup(); process.exit(); });

module.exports = { cleanup, events, handleIntercept, startSync, stopSync };

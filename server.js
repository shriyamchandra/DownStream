const express = require('express');
const { spawn, execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const EventEmitter = require('events');

const events = new EventEmitter();

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS Middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Request Logger
app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    if (req.method === 'POST') {
        console.log('Body:', JSON.stringify(req.body));
    }
    next();
});

// Resolve App Data Directory for writing writable files (like config and session)
let appDataDir = __dirname;
try {
    const { app: electronApp } = require('electron');
    if (electronApp) {
        appDataDir = electronApp.getPath('userData');
    }
} catch (e) {
    // Standalone Node.js mode
}

if (!fs.existsSync(appDataDir)) {
    fs.mkdirSync(appDataDir, { recursive: true });
}

// Load Config
const configPath = path.join(appDataDir, 'config.json');
let config = {
    preferredPlayer: 'vlc',
    downloadDir: path.join(process.env.HOME, 'Downloads', 'Aria2Streamer')
};

if (fs.existsSync(configPath)) {
    try {
        config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch(e) {
        console.error("Failed to parse config.json, using defaults.");
    }
} else {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
}

if (!fs.existsSync(config.downloadDir)) {
    fs.mkdirSync(config.downloadDir, { recursive: true });
}

// Session Persistence
const sessionPath = path.join(appDataDir, 'aria2.session');
if (!fs.existsSync(sessionPath)) {
    fs.writeFileSync(sessionPath, '');
}

// History Persistence
const historyPath = path.join(appDataDir, 'history.json');
let historyList = [];
if (fs.existsSync(historyPath)) {
    try {
        historyList = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch(e) {
        console.error("Failed to parse history.json, starting empty.");
    }
} else {
    fs.writeFileSync(historyPath, JSON.stringify(historyList, null, 4));
}

function saveHistory() {
    try {
        fs.writeFileSync(historyPath, JSON.stringify(historyList, null, 4));
    } catch(e) {
        console.error("Failed to save history:", e);
    }
}

// Locate aria2c
let aria2cPath = 'aria2c';
const packagedPath = process.resourcesPath ? path.join(process.resourcesPath, 'aria2c') : '';
const localPath = path.join(__dirname, 'bin', 'aria2c');

if (packagedPath && fs.existsSync(packagedPath)) {
    aria2cPath = packagedPath;
} else if (fs.existsSync(localPath)) {
    aria2cPath = localPath;
} else {
    try {
        aria2cPath = execSync('which aria2c').toString().trim();
    } catch (e) {
        if (fs.existsSync('/opt/homebrew/bin/aria2c')) aria2cPath = '/opt/homebrew/bin/aria2c';
        else if (fs.existsSync('/usr/local/bin/aria2c')) aria2cPath = '/usr/local/bin/aria2c';
    }
}

const aria2Args = [
    '--enable-rpc=true',
    '--rpc-allow-origin-all=true',
    '--rpc-listen-all=true',
    '--rpc-listen-port=6800',
    `--dir=${config.downloadDir}`,
    '--stream-piece-selector=inorder',
    '--allow-overwrite=true',
    '-x', '16', '-s', '16', '-c',
    '--file-allocation=none',
    '--auto-file-renaming=false',
    `--input-file=${sessionPath}`,
    `--save-session=${sessionPath}`,
    '--save-session-interval=10'
];

console.log(`Starting aria2c: ${aria2cPath} ${aria2Args.join(' ')}`);
let ariaProcess = spawn(aria2cPath, aria2Args, { stdio: 'inherit' });

ariaProcess.on('error', (err) => {
    console.error('Failed to start aria2c. Make sure it is installed (brew install aria2).', err);
});

// API to stream file via preferred player
app.post('/api/stream', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Filename required' });

    // Try to find the file recursively inside config.downloadDir to support subfolders/categories
    const findFile = (dir, name) => {
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
    };

    const filepath = findFile(config.downloadDir, path.basename(filename));
    if (!filepath) {
        return res.status(404).json({ error: 'File not found on disk yet.' });
    }

    try {
        const stat = fs.statSync(filepath);
        if (stat.size < 200000) {
            return res.status(400).json({ error: 'Buffer not reached. File is < 200KB.' });
        }
    } catch(e) {
        return res.status(500).json({ error: 'Could not read file size.' });
    }

    // Determine player application command flag
    let playerFlag = '';
    if (config.preferredPlayer === 'vlc') playerFlag = '-a VLC';
    else if (config.preferredPlayer === 'iina') playerFlag = '-a IINA';
    else if (config.preferredPlayer === 'mpv') playerFlag = '-a mpv';

    const command = playerFlag ? `open ${playerFlag} "${filepath}"` : `open "${filepath}"`;
    
    exec(command, (err) => {
        if (err) return res.status(500).json({ error: `Failed to launch ${config.preferredPlayer || 'default player'}.` });
        res.json({ success: true, message: 'Player launched!' });
    });
});

// API to delete files
app.post('/api/delete', (req, res) => {
    const { filepath } = req.body;
    if (!filepath) return res.status(400).json({ error: 'Filepath required' });

    // Ensure it's inside config.downloadDir for security
    if (!filepath.startsWith(config.downloadDir)) {
        return res.status(403).json({ error: 'Path traversal blocked.' });
    }

    try {
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
        if (fs.existsSync(filepath + '.aria2')) fs.unlinkSync(filepath + '.aria2');
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Failed to delete files.' });
    }
});

app.post('/api/showInFinder', (req, res) => {
    const { filepath } = req.body;
    if (!filepath) return res.status(400).json({ error: 'Filepath required' });

    if (!filepath.startsWith(config.downloadDir)) {
        return res.status(403).json({ error: 'Path traversal blocked.' });
    }

    // open -R highlights the file in Finder
    exec(`open -R "${filepath}"`, (err) => {
        if (err) return res.status(500).json({ error: 'Failed to open in Finder.' });
        res.json({ success: true });
    });
});

app.post('/api/notify', (req, res) => {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required' });

    const safeTitle = title.replace(/"/g, '\\"');
    const safeMessage = message.replace(/"/g, '\\"');

    exec(`osascript -e 'display notification "${safeMessage}" with title "${safeTitle}"'`, (err) => {
        res.json({ success: true });
    });
});

// Settings APIs
app.get('/api/settings', (req, res) => {
    res.json(config);
});

app.post('/api/settings', (req, res) => {
    const { preferredPlayer, downloadDir } = req.body;
    if (preferredPlayer) config.preferredPlayer = preferredPlayer;
    if (downloadDir) {
        config.downloadDir = path.resolve(downloadDir);
        if (!fs.existsSync(config.downloadDir)) {
            fs.mkdirSync(config.downloadDir, { recursive: true });
        }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    res.json({ success: true, config });
});

// History APIs
app.get('/api/history', (req, res) => {
    res.json(historyList);
});

app.post('/api/history/clear-completed', (req, res) => {
    const activeStatuses = ['active', 'waiting', 'paused'];
    const beforeCount = historyList.length;
    historyList = historyList.filter(item => activeStatuses.includes(item.status));
    if (historyList.length !== beforeCount) {
        saveHistory();
    }
    res.json({ success: true, count: beforeCount - historyList.length });
});

app.post('/api/history/delete', async (req, res) => {
    const { gid, deleteFile } = req.body;
    if (!gid) return res.status(400).json({ error: 'GID required' });

    const itemIndex = historyList.findIndex(x => x.gid === gid);
    if (itemIndex === -1) return res.status(404).json({ error: 'Item not found in history' });

    const item = historyList[itemIndex];
    
    try {
        if (item.status === 'active' || item.status === 'waiting' || item.status === 'paused') {
            await callAria2('remove', [gid]);
        } else {
            await callAria2('removeDownloadResult', [gid]);
        }
    } catch (e) {
        // Already removed or not in active session
    }

    if (deleteFile) {
        let filepaths = [];
        if (item.files && item.files.length > 0) {
            filepaths = item.files.map(f => f.path).filter(p => p);
        } else {
            const defaultPath = path.join(item.dir || config.downloadDir, item.filename);
            filepaths.push(defaultPath);
        }

        filepaths.forEach(filepath => {
            if (filepath.startsWith(config.downloadDir)) {
                try {
                    if (fs.existsSync(filepath)) {
                        const stat = fs.statSync(filepath);
                        if (stat.isDirectory()) {
                            fs.rmSync(filepath, { recursive: true, force: true });
                        } else {
                            fs.unlinkSync(filepath);
                        }
                    }
                    if (fs.existsSync(filepath + '.aria2')) {
                        fs.unlinkSync(filepath + '.aria2');
                    }
                } catch(e) {
                    console.error(`Failed to delete file ${filepath}:`, e);
                }
            }
        });
    }

    historyList.splice(itemIndex, 1);
    saveHistory();
    res.json({ success: true });
});

app.post('/api/history/retry', async (req, res) => {
    const { gid } = req.body;
    if (!gid) return res.status(400).json({ error: 'GID required' });

    const itemIndex = historyList.findIndex(x => x.gid === gid);
    if (itemIndex === -1) return res.status(404).json({ error: 'Item not found' });

    const item = historyList[itemIndex];
    if (!item.urls || item.urls.length === 0) {
        return res.status(400).json({ error: 'No URLs available to redownload' });
    }

    try {
        const options = {};
        if (item.filename && !item.filename.startsWith('Unknown')) {
            options.out = item.filename;
        }
        if (item.category && config.downloadDir) {
            options.dir = path.join(config.downloadDir, item.category);
        } else {
            options.dir = config.downloadDir;
        }

        const response = await callAria2('addUri', [[item.urls[0]], options]);
        if (response.error) {
            return res.status(500).json({ error: response.error.message });
        }

        historyList.splice(itemIndex, 1);
        saveHistory();

        res.json({ success: true, newGid: response.result });
    } catch (e) {
        res.status(500).json({ error: 'Failed to restart download.' });
    }
});

// Periodic background sync loop between aria2 and history.json
async function syncHistoryWithAria2() {
    try {
        const active = await callAria2('tellActive').catch(() => null);
        if (!active) return;
        
        const waiting = await callAria2('tellWaiting', [0, 1000]).catch(() => ({ result: [] }));
        const stopped = await callAria2('tellStopped', [0, 1000]).catch(() => ({ result: [] }));
        
        const ariaDownloads = [...(active.result || []), ...(waiting.result || []), ...(stopped.result || [])];
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
            
            const dir = ad.dir || config.downloadDir;
            let category = '';
            if (dir.startsWith(config.downloadDir)) {
                const sub = dir.slice(config.downloadDir.length).replace(/^[/\\]+/, '');
                if (sub) {
                    category = sub.split(/[/\\]/)[0];
                }
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
                    } catch(e) {
                        filename = 'downloaded_file';
                    }
                }
            }
            
            let item = historyList.find(x => x.gid === gid);
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
                historyList.unshift(item);
                changed = true;
            } else {
                if (item.status !== status || item.completedLength !== completedLength || item.totalLength !== totalLength || item.downloadSpeed !== downloadSpeed) {
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
        }
        
        const activeStatuses = ['active', 'waiting', 'paused'];
        for (const item of historyList) {
            if (activeStatuses.includes(item.status)) {
                const stillInAria = ariaDownloads.some(ad => ad.gid === item.gid);
                if (!stillInAria) {
                    item.status = 'removed';
                    item.downloadSpeed = 0;
                    changed = true;
                }
            }
        }
        
        if (changed) {
            saveHistory();
        }
    } catch(e) {
        console.error("Error in syncHistoryWithAria2:", e);
    }
}

// Start background syncing
setInterval(syncHistoryWithAria2, 2500);

// Helper to make RPC requests to aria2c
function callAria2(method, params) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            jsonrpc: '2.0',
            id: 'backend',
            method: `aria2.${method}`,
            params: params
        });

        const req = http.request({
            hostname: 'localhost',
            port: 6800,
            path: '/jsonrpc',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch(e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// API endpoint for Chrome Extension interception
app.post('/api/intercept', async (req, res) => {
    const { url, filename, referrer, userAgent, cookies } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    let options = {};
    if (filename) options.out = filename;
    if (referrer) options.referer = referrer;
    if (userAgent) options['user-agent'] = userAgent;

    if (cookies) {
        options.header = [`Cookie: ${cookies}`];
    }

    try {
        const response = await callAria2('addUri', [[url], options]);
        if (response.error) {
            return res.status(500).json({ error: response.error.message });
        }

        // Trigger native macOS notification for user feedback
        const rawFilename = filename || url.split('/').pop().split('?')[0] || 'large_file';
        const cleanFilename = decodeURIComponent(rawFilename).replace(/"/g, '\\"');
        const title = 'Aria2 Streamer';
        const msg = `Captured: ${cleanFilename.substring(0, 45)}... downloading at max speed!`;
        
        exec(`osascript -e 'display notification "${msg}" with title "${title}"'`);

        // Emit intercept event so Electron can restore/focus the app window
        events.emit('intercept', { url, filename });

        res.json({ success: true, gid: response.result });
    } catch(e) {
        res.status(500).json({ error: 'Failed to communicate with aria2c engine.' });
    }
});

app.listen(port, () => {
    console.log(`\n============================================`);
    console.log(`🚀 Aria2 Streamer Web Manager is running!`);
    console.log(`👉 Open your browser to: http://localhost:${port}`);
    console.log(`============================================\n`);
});

// Cleanup on exit
function cleanup() {
    console.log('Cleaning up aria2c process...');
    if (ariaProcess) {
        try {
            ariaProcess.kill('SIGINT');
            const killTimer = setTimeout(() => {
                try {
                    ariaProcess.kill('SIGKILL');
                } catch (e) {
                    // Ignore kill errors on shutdown
                }
            }, 1500);
            ariaProcess.once('exit', () => clearTimeout(killTimer));
        } catch (e) {
            console.error('Error killing aria2c process:', e);
        }
    }
}

process.on('SIGINT', () => {
    cleanup();
    process.exit();
});

process.on('SIGTERM', () => {
    cleanup();
    process.exit();
});

module.exports = {
    cleanup,
    events
};

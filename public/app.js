// ===== DIAGNOSTIC LOGGING =====
function _log(msg) {
    console.log(`[DIAG] ${msg}`);
}

// Step 1: Detect environment
_log('=== DownStream Diagnostics ===');
_log(`window.__TAURI__ = ${typeof window.__TAURI__} | value = ${JSON.stringify(window.__TAURI__ ? Object.keys(window.__TAURI__) : null)}`);

const isTauri = window.__TAURI__ !== undefined;
_log(`isTauri = ${isTauri}`);

if (isTauri) {
    _log(`__TAURI__.core = ${typeof window.__TAURI__?.core}`);
    _log(`__TAURI__.core.invoke = ${typeof window.__TAURI__?.core?.invoke}`);
}

// Step 2: Error catchers
window.onerror = function(message, source, lineno) {
    _log(`❌ JS ERROR: ${message} at ${source}:${lineno}`);
};
window.onunhandledrejection = function(event) {
    _log(`❌ UNHANDLED REJECTION: ${event.reason}`);
};

class Aria2Client {
    constructor() {
        if (isTauri) {
            _log('Aria2Client: Using Tauri IPC bridge');
            // Defer so onConnect can be assigned by the caller first
            setTimeout(() => {
                _log('Testing aria2_rpc invoke with getVersion...');
                this._tryConnect(0);
            }, 50);
        } else {
            _log('Aria2Client: Using WebSocket (not Tauri)');
            this.ws = new WebSocket('ws://127.0.0.1:6800/jsonrpc');
            this.msgId = 0;
            this.callbacks = {};
            this.onMessage = null;

            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.id && this.callbacks[data.id]) {
                    const { resolve, reject } = this.callbacks[data.id];
                    delete this.callbacks[data.id];
                    // Reject on RPC errors so callers' .catch() works. Previously the
                    // error object was resolved as if it were a result, which then blew
                    // up when spread into an array (e.g. [...tellActive()]).
                    if (data.error) reject(data.error);
                    else resolve(data.result);
                } else if (data.method && this.onMessage) {
                    this.onMessage(data);
                }
            };

            this.ws.onopen = () => {
                _log('✅ WebSocket connected to aria2c');
                if (this.onConnect) this.onConnect();
            };

            this.ws.onerror = (e) => {
                _log(`❌ WebSocket ERROR: ${JSON.stringify(e)}`);
                document.getElementById('downloadsList').innerHTML = `<div class="empty-state" style="color: #ff453a">Could not connect to aria2c engine. Make sure the backend server is running.</div>`;
            };

            this.ws.onclose = (e) => {
                _log(`⚠️ WebSocket CLOSED: code=${e.code} reason=${e.reason}`);
            };
        }
    }

    // Retry connecting to aria2c (it takes a moment to start)
    _tryConnect(attempt) {
        window.__TAURI__.core.invoke('aria2_rpc', { method: 'getVersion', params: [] })
            .then(result => {
                _log(`✅ aria2_rpc getVersion SUCCESS (attempt ${attempt}): ${JSON.stringify(result).substring(0, 200)}`);
                if (this.onConnect) this.onConnect();
            })
            .catch(err => {
                _log(`⚠️ aria2_rpc attempt ${attempt} failed: ${err}`);
                if (attempt < 10) {
                    setTimeout(() => this._tryConnect(attempt + 1), 500);
                } else {
                    _log('❌ Failed to connect to aria2c after 10 attempts');
                }
            });
    }

    call(method, params = []) {
        if (isTauri) {
            return new Promise(async (resolve, reject) => {
                _log(`→ invoke aria2_rpc("${method}", ${JSON.stringify(params).substring(0, 100)})`);
                try {
                    const result = await window.__TAURI__.core.invoke('aria2_rpc', { method, params });
                    _log(`← aria2_rpc("${method}") OK: ${JSON.stringify(result).substring(0, 150)}`);
                    resolve(result);
                } catch (err) {
                    _log(`← aria2_rpc("${method}") FAIL: ${err}`);
                    reject(err);
                }
            });
        } else {
            return new Promise((resolve, reject) => {
                const id = ++this.msgId;
                this.callbacks[id] = { resolve, reject };
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        jsonrpc: '2.0',
                        id: id.toString(),
                        method: `aria2.${method}`,
                        params: params
                    }));
                } else {
                    setTimeout(() => this.call(method, params).then(resolve, reject), 500);
                }
            });
        }
    }
}

// Theme Management
function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light') {
        root.classList.add('theme-light');
        root.classList.remove('theme-dark');
    } else if (theme === 'dark') {
        root.classList.add('theme-dark');
        root.classList.remove('theme-light');
    } else {
        root.classList.remove('theme-light', 'theme-dark');
    }
}

// Initial theme application
const savedTheme = localStorage.getItem('appTheme') || 'system';
applyTheme(savedTheme);

// Universal API Wrapper for Tauri IPC and Express HTTP API
async function callApi(endpoint, data = {}) {
    if (isTauri) {
        if (endpoint === '/api/settings') {
            if (Object.keys(data).length === 0) {
                return await window.__TAURI__.core.invoke('load_settings');
            } else {
                await window.__TAURI__.core.invoke('save_settings', { settings: data });
                return { success: true, config: data };
            }
        } else if (endpoint === '/api/stream') {
            try {
                await window.__TAURI__.core.invoke('stream_file', {
                    filename: data.filename,
                    downloadDir: appConfig.downloadDir,
                    preferredPlayer: appConfig.preferredPlayer
                });
                return { success: true };
            } catch (err) {
                return { error: err };
            }
        } else if (endpoint === '/api/delete') {
            await window.__TAURI__.core.invoke('delete_file', {
                filepath: data.filepath,
                downloadDir: appConfig.downloadDir
            });
            return { success: true };
        } else if (endpoint === '/api/showInFinder') {
            await window.__TAURI__.core.invoke('show_in_finder', {
                filepath: data.filepath,
                downloadDir: appConfig.downloadDir
            });
            return { success: true };
        } else if (endpoint === '/api/notify') {
            await window.__TAURI__.core.invoke('show_notification', {
                title: data.title,
                message: data.message
            });
            return { success: true };
        }
    } else {
        if (Object.keys(data).length === 0) {
            const res = await fetch(endpoint);
            return await res.json();
        } else {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return await res.json();
        }
    }
}

const client = new Aria2Client();
let downloads = [];
let currentFilter = 'all';
let appConfig = { preferredPlayer: 'vlc', downloadDir: '' };
let speedHistory = [];
const maxSpeedPoints = 30;
let expandedGids = new Set();

client.onMessage = async (data) => {
    // Instantly refresh list on download start, complete, pause, stop, or error
    if (data.method && data.method.startsWith('aria2.onDownload')) {
        refreshDownloads();
    }

    if (data.method === 'aria2.onDownloadComplete') {
        const gid = data.params[0].gid;
        // Try to find the title from memory
        const d = downloads.find(x => x.gid === gid);
        if (d) {
            const filename = getFileName(d);
            callApi('/api/notify', {
                title: 'DownStream',
                message: `Download Complete: ${filename}`
            });
        }
    }
};

// Telemetry speed sparkline drawing
function drawSpeedGraph() {
    const canvas = document.getElementById('speedGraph');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    
    // Scale canvas buffer if size doesn't match style size (retina display support)
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
    }
    
    const width = rect.width;
    const height = rect.height;
    
    ctx.clearRect(0, 0, width, height);
    
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--accent').trim() || '#3b82f6';
    const borderColor = style.getPropertyValue('--border-subtle').trim() || 'rgba(255, 255, 255, 0.05)';
    const mutedColor = style.getPropertyValue('--text-tertiary').trim() || '#6e6e7a';

    // Empty state: no traffic to plot — show a centered label instead of a flat line/empty grid.
    const hasTraffic = speedHistory.length >= 2 && Math.max(...speedHistory) > 0;
    if (!hasTraffic) {
        ctx.fillStyle = mutedColor;
        ctx.font = "500 11px -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No active traffic', width / 2, height / 2);
        return;
    }

    // Draw subtle grid lines
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 0.5;
    for (let i = 1; i < 3; i++) {
        const y = (height / 3) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }
    
    // Scale graph (minimum peak of 500 KB/s)
    const maxVal = Math.max(...speedHistory, 500 * 1024);
    
    const points = [];
    const step = width / (maxSpeedPoints - 1);
    const offsetIndex = maxSpeedPoints - speedHistory.length;
    
    for (let i = 0; i < speedHistory.length; i++) {
        const x = (offsetIndex + i) * step;
        const y = height - 4 - ((speedHistory[i] / maxVal) * (height - 8));
        points.push({ x, y });
    }
    
    // Draw gradient fill
    ctx.beginPath();
    ctx.moveTo(points[0].x, height);
    ctx.lineTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    ctx.quadraticCurveTo(points[points.length - 1].x, points[points.length - 1].y, points[points.length - 1].x, points[points.length - 1].y);
    ctx.lineTo(width, height);
    ctx.closePath();
    
    const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
    fillGrad.addColorStop(0, accent + '40'); // 25% opacity
    fillGrad.addColorStop(1, accent + '00'); // 0% opacity
    ctx.fillStyle = fillGrad;
    ctx.fill();
    
    // Draw glowing line
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    ctx.quadraticCurveTo(points[points.length - 1].x, points[points.length - 1].y, points[points.length - 1].x, points[points.length - 1].y);
    
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

// Update navbar badges
function updateBadge(id, count) {
    const badge = document.getElementById(id);
    if (!badge) return;
    if (count > 0) {
        badge.innerText = count;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

// Setup navigation listeners
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');
        currentFilter = item.getAttribute('data-filter');

        const downloadsView = document.getElementById('downloadsView');
        const settingsView = document.getElementById('settingsView');
        const toolbar = document.querySelector('.toolbar');

        if (currentFilter === 'settings') {
            if (downloadsView) downloadsView.classList.add('hidden');
            if (toolbar) toolbar.classList.add('hidden');
            if (settingsView) settingsView.classList.remove('hidden');
        } else {
            if (downloadsView) downloadsView.classList.remove('hidden');
            if (toolbar) toolbar.classList.remove('hidden');
            if (settingsView) settingsView.classList.add('hidden');
            renderDownloads();
        }
    });
});

// Escape untrusted text (filenames, URLs, error messages — all attacker-influenced
// via the download source) before interpolating into innerHTML, to prevent XSS.
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
    if (bytes == 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(seconds) {
    if (seconds === Infinity || seconds === 0 || isNaN(seconds)) return '--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function getFileName(d) {
    if (d.bittorrent && d.bittorrent.info && d.bittorrent.info.name) {
        return d.bittorrent.info.name;
    }
    if (d.files && d.files.length > 0) {
        if (d.files[0].path) {
            return d.files[0].path.split('/').pop();
        } else if (d.files[0].uris && d.files[0].uris.length > 0) {
            try {
                const urlObj = new URL(d.files[0].uris[0].uri);
                return urlObj.pathname.split('/').pop() || 'downloaded_file';
            } catch(e) {
                return 'downloaded_file';
            }
        }
    }
    return 'Unknown File';
}

client.onConnect = () => {
    loadSettings();
    refreshDownloads();
    setInterval(refreshDownloads, 1000); 
};

async function loadSettings() {
    try {
        appConfig = await callApi('/api/settings');
        document.getElementById('prefPlayer').value = appConfig.preferredPlayer;
        document.getElementById('prefDir').value = appConfig.downloadDir;
        document.getElementById('prefTheme').value = localStorage.getItem('appTheme') || 'system';
    } catch(e) {
        console.error("Failed to load settings", e);
    }
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const preferredPlayer = document.getElementById('prefPlayer').value;
    const downloadDir = document.getElementById('prefDir').value.trim();
    const preferredTheme = document.getElementById('prefTheme').value;

    try {
        const data = await callApi('/api/settings', { preferredPlayer, downloadDir });
        if (data.success) {
            appConfig = data.config;
            
            // Save and apply theme locally
            localStorage.setItem('appTheme', preferredTheme);
            applyTheme(preferredTheme);

            await client.call('changeGlobalOption', [{ dir: downloadDir }]);
            alert("Settings saved successfully!");
        }
    } catch(e) {
        alert("Failed to save settings.");
    }
});

async function refreshDownloads() {
    try {
        const active = await client.call('tellActive').catch(() => []);
        const waiting = await client.call('tellWaiting', [0, 100]).catch(() => []);
        const stopped = await client.call('tellStopped', [0, 100]).catch(() => []);
        const globalStat = await client.call('getGlobalStat').catch(() => ({ downloadSpeed: 0, uploadSpeed: 0 }));
        
        const liveDownloads = [...active, ...waiting, ...stopped];
        const historyList = await callApi('/api/history').catch(() => []);
        
        // Merge: map GIDs to combined items
        const mergedMap = new Map();
        
        historyList.forEach(item => {
            mergedMap.set(item.gid, item);
        });
        
        liveDownloads.forEach(item => {
            const existing = mergedMap.get(item.gid) || {};
            mergedMap.set(item.gid, { ...existing, ...item });
        });
        
        downloads = [];
        const seen = new Set();
        
        historyList.forEach(hItem => {
            if (mergedMap.has(hItem.gid)) {
                downloads.push(mergedMap.get(hItem.gid));
                seen.add(hItem.gid);
            }
        });
        
        liveDownloads.forEach(lItem => {
            if (!seen.has(lItem.gid)) {
                downloads.push(lItem);
            }
        });
        
        // Update Global Stats
        document.getElementById('globalDl').innerText = formatBytes(globalStat.downloadSpeed) + '/s';
        document.getElementById('globalUl').innerText = formatBytes(globalStat.uploadSpeed) + '/s';
        
        // Update speed history
        const dlSpeed = parseInt(globalStat.downloadSpeed) || 0;
        speedHistory.push(dlSpeed);
        if (speedHistory.length > maxSpeedPoints) {
            speedHistory.shift();
        }
        drawSpeedGraph();

        // Update badge counts
        const allCount = downloads.length;
        const activeCount = downloads.filter(d => d.status === 'active' || d.status === 'waiting' || d.status === 'paused').length;
        const completeCount = downloads.filter(d => d.status === 'complete').length;
        const failedCount = downloads.filter(d => d.status === 'error' || d.status === 'removed').length;

        updateBadge('badgeAll', allCount);
        updateBadge('badgeActive', activeCount);
        updateBadge('badgeComplete', completeCount);
        updateBadge('badgeFailed', failedCount);
        
        renderDownloads();
    } catch(e) {
        console.error("Failed to fetch data", e);
    }
}

function getStatusClass(status) {
    if (status === 'active' || status === 'waiting') return 'status-active';
    if (status === 'paused') return 'status-paused';
    if (status === 'complete') return 'status-complete';
    return 'status-error';
}

function getStatusText(status) {
    if (status === 'active') return 'Downloading';
    if (status === 'waiting') return 'Waiting';
    if (status === 'paused') return 'Paused';
    if (status === 'complete') return 'Complete';
    if (status === 'error') return 'Failed';
    if (status === 'removed') return 'Cancelled';
    return status;
}

// Icons
const iconPause = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
const iconPlay = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
const iconCancel = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
const iconTrash = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
const iconRestart = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg>`;
const iconFolder = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;

function getFileIconClass(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm3u8'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext)) return 'audio';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return 'zip';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) return 'image';
    if (['pdf'].includes(ext)) return 'pdf';
    return 'doc'; // default
}

function getFileIconText(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (ext.length > 0 && ext.length <= 4) return ext.toUpperCase();
    return 'FILE';
}

function getDetailsHtml(d) {
    const addedStr = d.addedDate ? new Date(d.addedDate).toLocaleString() : 'Unknown';
    const completedStr = d.completedDate ? new Date(d.completedDate).toLocaleString() : '';
    
    // Files list
    let filesHtml = '';
    if (d.files && d.files.length > 0) {
        const showFileList = d.files.length > 1 || d.bittorrent;
        if (showFileList) {
            filesHtml += `
                <div class="details-section files-list-section">
                    <h4>Files in Download (${d.files.length})</h4>
                    <div class="details-files-container">
            `;
            d.files.forEach((f, idx) => {
                const fLength = parseInt(f.length) || 0;
                const fCompleted = parseInt(f.completedLength) || 0;
                const fPct = fLength === 0 ? 0 : Math.floor((fCompleted / fLength) * 100);
                let fPath = f.path || 'Pending...';
                if (f.path && d.dir) {
                    if (f.path.startsWith(d.dir)) {
                        fPath = f.path.slice(d.dir.length).replace(/^[/\\]+/, '');
                    } else {
                        fPath = f.path.split('/').pop();
                    }
                }
                filesHtml += `
                    <div class="details-file-row">
                        <div class="file-row-info">
                            <span class="file-row-index">${idx + 1}</span>
                            <span class="file-row-name" title="${escapeHtml(fPath)}">${escapeHtml(fPath)}</span>
                            <span class="file-row-size">${formatBytes(fCompleted)} / ${formatBytes(fLength)}</span>
                        </div>
                        <div class="file-row-progress-container">
                            <div class="file-row-progress-bar" style="width: ${fPct}%"></div>
                        </div>
                    </div>
                `;
            });
            filesHtml += `
                    </div>
                </div>
            `;
        }
    }

    // Connection / Torrent Peers metadata
    let metaStatsHtml = '';
    if (d.status === 'active') {
        const conns = d.connections || 0;
        const seeders = d.numSeeders !== undefined ? ` · Seeds: ${d.numSeeders}` : '';
        const upload = parseInt(d.uploadSpeed) || 0;
        metaStatsHtml = `
            <div class="detail-meta-item">
                <strong>Connections:</strong> <span>${conns}${seeders}</span>
            </div>
            <div class="detail-meta-item">
                <strong>Upload Speed:</strong> <span>${formatBytes(upload)}/s</span>
            </div>
        `;
    }

    // Error display
    let errorBlock = '';
    if (d.status === 'error' && d.errorMessage) {
        errorBlock = `
            <div class="details-error-box">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                <span><strong>Error Details:</strong> ${escapeHtml(d.errorMessage)}</span>
            </div>
        `;
    }

    const downloadDirDisplay = d.dir || appConfig.downloadDir || 'Default';
    const sourceUrl = (d.urls && d.urls.length > 0) ? d.urls[0] : 'Magnet / Torrent file';

    return `
        <div class="row-details">
            ${errorBlock}
            <div class="details-grid">
                <div class="detail-meta-item full-width">
                    <strong>Source URL:</strong> <span class="url-text" title="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</span>
                </div>
                <div class="detail-meta-item full-width">
                    <strong>Save Path:</strong> <span class="path-text" title="${escapeHtml(downloadDirDisplay)}">${escapeHtml(downloadDirDisplay)}</span>
                </div>
                <div class="detail-meta-item">
                    <strong>Date Added:</strong> <span>${addedStr}</span>
                </div>
                ${completedStr ? `
                <div class="detail-meta-item">
                    <strong>Date Completed:</strong> <span>${completedStr}</span>
                </div>
                ` : ''}
                ${metaStatsHtml}
            </div>
            ${filesHtml}
        </div>
    `;
}

function renderDownloads() {
    const list = document.getElementById('downloadsList');
    if (!list) return;
    
    let filteredDownloads = downloads;
    
    // 1. Sidebar Nav Filter
    if (currentFilter === 'active') {
        filteredDownloads = downloads.filter(d => d.status === 'active' || d.status === 'waiting' || d.status === 'paused');
    } else if (currentFilter === 'complete') {
        filteredDownloads = downloads.filter(d => d.status === 'complete');
    } else if (currentFilter === 'failed') {
        filteredDownloads = downloads.filter(d => d.status === 'error' || d.status === 'removed');
    }

    // 2. Search Filter
    const searchVal = document.getElementById('searchBar').value.toLowerCase().trim();
    if (searchVal) {
        filteredDownloads = filteredDownloads.filter(d => {
            const filename = getFileName(d).toLowerCase();
            const urls = (d.urls || []).join(' ').toLowerCase();
            return filename.includes(searchVal) || urls.includes(searchVal);
        });
    }

    // 3. Sorting
    const sortVal = document.getElementById('sortSelect').value;
    if (sortVal === 'date-desc') {
        filteredDownloads.sort((a, b) => new Date(b.addedDate || Date.now()) - new Date(a.addedDate || Date.now()));
    } else if (sortVal === 'date-asc') {
        filteredDownloads.sort((a, b) => new Date(a.addedDate || Date.now()) - new Date(b.addedDate || Date.now()));
    } else if (sortVal === 'name-asc') {
        filteredDownloads.sort((a, b) => getFileName(a).localeCompare(getFileName(b)));
    } else if (sortVal === 'name-desc') {
        filteredDownloads.sort((a, b) => getFileName(b).localeCompare(getFileName(a)));
    } else if (sortVal === 'size-desc') {
        filteredDownloads.sort((a, b) => (parseInt(b.totalLength) || 0) - (parseInt(a.totalLength) || 0));
    } else if (sortVal === 'size-asc') {
        filteredDownloads.sort((a, b) => (parseInt(a.totalLength) || 0) - (parseInt(b.totalLength) || 0));
    }

    if (filteredDownloads.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📂</div>
                <h3>No Downloads Found</h3>
                <p>Try pasting a URL above or adjust your search filters.</p>
            </div>
        `;
        list.dataset.gidOrder = '';
        return;
    }

    // Determine current GID order
    const currentGidString = filteredDownloads.map(d => d.gid).join(',');
    const oldGidString = list.dataset.gidOrder || '';

    if (currentGidString !== oldGidString) {
        // Render full HTML list
        let html = '';
        filteredDownloads.forEach(d => {
            const total = parseInt(d.totalLength) || 0;
            const completed = parseInt(d.completedLength) || 0;
            const speed = parseInt(d.downloadSpeed) || 0;
            const pct = total === 0 ? 0 : Math.floor((completed / total) * 100);
            const etaSeconds = speed === 0 ? 0 : Math.floor((total - completed) / speed);

            let filename = getFileName(d);
            const isStreamable = completed > 200000 || d.status === 'complete';
            const showSpeed = d.status === 'active';
            const speedInner = showSpeed ? `Speed: ${formatBytes(speed)}/s <span class="eta">· ETA ${formatTime(etaSeconds)}</span>` : '';

            const isExpanded = expandedGids.has(d.gid);
            const detailsHtml = isExpanded ? getDetailsHtml(d) : '';

            html += `
                <div class="download-row ${isExpanded ? 'expanded' : ''}" id="dl-${d.gid}" onclick="toggleExpand('${d.gid}', event)">
                    <div class="row-top">
                        <div class="file-icon ${getFileIconClass(filename)}">
                            ${getFileIconText(filename)}
                        </div>
                        <div class="file-info">
                            <div class="row-name" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>
                            <div class="row-meta">
                                <span class="row-size">${formatBytes(completed)} / ${total > 0 ? formatBytes(total) : '??'}</span>
                                <span class="status-badge ${getStatusClass(d.status)}">${getStatusText(d.status)}</span>
                                <span class="row-speed"${showSpeed ? '' : ' hidden'}>${speedInner}</span>
                            </div>
                        </div>
                        <div class="row-actions" data-status="${d.status}" data-streamable="${isStreamable ? '1' : '0'}">
                            ${d.status === 'active'  ? `<button class="btn-icon-small" onclick="pauseDl('${d.gid}', event)" title="Pause">${iconPause}</button>` : ''}
                            ${d.status === 'paused'  ? `<button class="btn-icon-small" onclick="resumeDl('${d.gid}', event)" title="Resume">${iconPlay}</button>` : ''}
                            ${(d.status === 'active' || d.status === 'paused') ? `<button class="btn-icon-small" onclick="deleteDownload('${d.gid}', false, event)" title="Cancel">${iconCancel}</button>` : ''}
                            ${(d.status === 'complete' || d.status === 'error' || d.status === 'removed') ? `<button class="btn-icon-small" onclick="deleteDownload('${d.gid}', true, event)" title="Delete">${iconTrash}</button>` : ''}
                            ${(d.status === 'error' || d.status === 'removed') ? `<button class="btn-icon-small" style="color:var(--warning);" onclick="restartDl('${d.gid}', event)" title="Retry">${iconRestart}</button>` : ''}
                            ${isStreamable ? `<button class="btn-icon-small" onclick="showInFinder('${d.gid}', event)" title="Show in Finder">${iconFolder}</button>` : ''}
                            ${isStreamable ? `<button class="btn-stream" onclick="streamFile('${d.gid}', event)">▶ Stream</button>` : ''}
                        </div>
                    </div>
                    <div class="row-progress-container">
                        <div class="row-progress-bar" style="width:${pct}%"></div>
                    </div>
                    ${detailsHtml}
                </div>
            `;
        });
        list.innerHTML = html;
        list.dataset.gidOrder = currentGidString;
    } else {
        // Fast in-place DOM updates
        filteredDownloads.forEach(d => {
            const row = document.getElementById(`dl-${d.gid}`);
            if (!row) return;

            const total = parseInt(d.totalLength) || 0;
            const completed = parseInt(d.completedLength) || 0;
            const speed = parseInt(d.downloadSpeed) || 0;
            const pct = total === 0 ? 0 : Math.floor((completed / total) * 100);
            const etaSeconds = speed === 0 ? 0 : Math.floor((total - completed) / speed);

            let filename = getFileName(d);
            const isStreamable = completed > 200000 || d.status === 'complete';
            const showSpeed = d.status === 'active';
            const speedInner = showSpeed ? `Speed: ${formatBytes(speed)}/s <span class="eta">· ETA ${formatTime(etaSeconds)}</span>` : '';

            // 1. Update progress bar
            const bar = row.querySelector('.row-progress-bar');
            if (bar) bar.style.width = pct + '%';

            // 2. Update size text
            const sizeSpan = row.querySelector('.row-size');
            if (sizeSpan) sizeSpan.innerText = `${formatBytes(completed)} / ${total > 0 ? formatBytes(total) : '??'}`;

            // 3. Update status badge
            const badge = row.querySelector('.status-badge');
            if (badge) {
                badge.className = `status-badge ${getStatusClass(d.status)}`;
                badge.innerText = getStatusText(d.status);
            }

            // 4. Update speed text — hidden entirely unless actively downloading
            const speedSpan = row.querySelector('.row-speed');
            if (speedSpan) {
                speedSpan.hidden = !showSpeed;
                speedSpan.innerHTML = speedInner;
            }

            // 5. Rebuild row action buttons when status OR streamability changes.
            //    (Streamability flips to true once the buffer threshold is crossed
            //     mid-download, even though the status stays 'active' — so it must
            //     be part of this check or the Stream button never appears.)
            const actionsContainer = row.querySelector('.row-actions');
            const streamableFlag = isStreamable ? '1' : '0';
            if (actionsContainer && (actionsContainer.dataset.status !== d.status || actionsContainer.dataset.streamable !== streamableFlag)) {
                actionsContainer.innerHTML = `
                    ${d.status === 'active'  ? `<button class="btn-icon-small" onclick="pauseDl('${d.gid}', event)" title="Pause">${iconPause}</button>` : ''}
                    ${d.status === 'paused'  ? `<button class="btn-icon-small" onclick="resumeDl('${d.gid}', event)" title="Resume">${iconPlay}</button>` : ''}
                    ${(d.status === 'active' || d.status === 'paused') ? `<button class="btn-icon-small" onclick="deleteDownload('${d.gid}', false, event)" title="Cancel">${iconCancel}</button>` : ''}
                    ${(d.status === 'complete' || d.status === 'error' || d.status === 'removed') ? `<button class="btn-icon-small" onclick="deleteDownload('${d.gid}', true, event)" title="Delete">${iconTrash}</button>` : ''}
                    ${(d.status === 'error' || d.status === 'removed') ? `<button class="btn-icon-small" style="color:var(--warning);" onclick="restartDl('${d.gid}', event)" title="Retry">${iconRestart}</button>` : ''}
                    ${isStreamable ? `<button class="btn-icon-small" onclick="showInFinder('${d.gid}', event)" title="Show in Finder">${iconFolder}</button>` : ''}
                    ${isStreamable ? `<button class="btn-stream" onclick="streamFile('${d.gid}', event)">▶ Stream</button>` : ''}
                `;
                actionsContainer.dataset.status = d.status;
                actionsContainer.dataset.streamable = streamableFlag;
            }

            // 6. Update details expanded/collapsed state
            const isExpanded = expandedGids.has(d.gid);
            const detailsContainer = row.querySelector('.row-details');

            if (isExpanded) {
                if (!row.classList.contains('expanded')) {
                    row.classList.add('expanded');
                }
                if (!detailsContainer) {
                    row.insertAdjacentHTML('beforeend', getDetailsHtml(d));
                } else {
                    // Update in-place to avoid re-triggering entrance animation and scroll reset
                    if (d.status === 'active') {
                        const conns = d.connections || 0;
                        const seeders = d.numSeeders !== undefined ? ` · Seeds: ${d.numSeeders}` : '';
                        const upload = parseInt(d.uploadSpeed) || 0;

                        const metaGrid = detailsContainer.querySelector('.details-grid');
                        if (metaGrid) {
                            const items = metaGrid.querySelectorAll('.detail-meta-item');
                            items.forEach(item => {
                                const header = item.querySelector('strong');
                                const valueSpan = item.querySelector('span');
                                if (header && valueSpan) {
                                    const headerText = header.innerText.toUpperCase();
                                    if (headerText.includes('CONNECTIONS')) {
                                        valueSpan.innerText = `${conns}${seeders}`;
                                    } else if (headerText.includes('UPLOAD SPEED')) {
                                        valueSpan.innerText = `${formatBytes(upload)}/s`;
                                    }
                                }
                            });
                        }
                    }

                    // Update sub-files progress/sizes
                    if (d.files && d.files.length > 0) {
                        d.files.forEach((f, idx) => {
                            const fLength = parseInt(f.length) || 0;
                            const fCompleted = parseInt(f.completedLength) || 0;
                            const fPct = fLength === 0 ? 0 : Math.floor((fCompleted / fLength) * 100);

                            const fileRow = detailsContainer.querySelector(`.details-file-row:nth-child(${idx + 1})`);
                            if (fileRow) {
                                const fileBar = fileRow.querySelector('.file-row-progress-bar');
                                if (fileBar) fileBar.style.width = fPct + '%';
                                const fileSize = fileRow.querySelector('.file-row-size');
                                if (fileSize) fileSize.innerText = `${formatBytes(fCompleted)} / ${formatBytes(fLength)}`;
                            }
                        });
                    }
                }
            } else {
                if (row.classList.contains('expanded')) {
                    row.classList.remove('expanded');
                }
                if (detailsContainer) {
                    detailsContainer.remove();
                }
            }
        });
    }
}

window.toggleExpand = (gid, e) => {
    // If the click is on an input, button, select, path, svg or row-actions container, do not toggle
    if (e.target.closest('.row-actions') || e.target.closest('button') || e.target.closest('a')) {
        return;
    }
    if (expandedGids.has(gid)) {
        expandedGids.delete(gid);
    } else {
        expandedGids.add(gid);
    }
    renderDownloads();
};

document.getElementById('addBtn').addEventListener('click', async () => {
    const text = document.getElementById('urlInput').value.trim();
    const filename = document.getElementById('filenameInput').value.trim();
    const category = document.getElementById('categorySelect').value;
    if (!text) return;

    const urls = text.split(/[\n,]+/).map(u => u.trim()).filter(u => u);

    for (let url of urls) {
        let options = {};
        if (filename && urls.length === 1) options.out = filename;
        if (category && appConfig.downloadDir) {
            options.dir = `${appConfig.downloadDir}/${category}`;
        }
        await client.call('addUri', [[url], options]).catch(() => {});
    }

    document.getElementById('urlInput').value = '';
    document.getElementById('filenameInput').value = '';
    refreshDownloads();
});

window.pauseDl = (gid, e) => {
    if (e) e.stopPropagation();
    client.call('pause', [gid]).catch(() => {});
};

window.resumeDl = (gid, e) => {
    if (e) e.stopPropagation();
    client.call('unpause', [gid]).catch(() => {});
};

window.deleteDownload = async (gid, isHistorical, e) => {
    if (e) e.stopPropagation();
    const d = downloads.find(x => x.gid === gid);
    if (!d) return;

    const filename = getFileName(d);
    const filepath = d.files?.[0]?.path;
    const hasFiles = filepath && parseInt(d.completedLength) > 0;

    let deleteFiles = false;
    if (hasFiles) {
        deleteFiles = confirm(`Do you want to delete the downloaded files from disk as well to keep your drive clean?\n\nFile: ${filename}`);
    } else if (!isHistorical) {
        const confirmCancel = confirm(`Are you sure you want to cancel downloading: ${filename}?`);
        if (!confirmCancel) return;
    } else {
        const confirmRemove = confirm(`Are you sure you want to remove ${filename} from history?`);
        if (!confirmRemove) return;
    }

    try {
        await callApi('/api/history/delete', { gid, deleteFile: deleteFiles });
        refreshDownloads();
    } catch(e) {
        console.error("Failed to delete download", e);
    }
};

window.restartDl = async (gid, e) => {
    if (e) e.stopPropagation();
    const d = downloads.find(x => x.gid === gid);
    if (!d) return;

    const confirmRestart = confirm(`Do you want to restart download: ${d.filename}?`);
    if (!confirmRestart) return;

    try {
        const res = await callApi('/api/history/retry', { gid });
        if (res.success) {
            refreshDownloads();
        } else {
            alert("Failed to restart: " + (res.error || "Unknown error"));
        }
    } catch(e) {
        alert('Failed to restart download.');
    }
};

window.streamFile = async (gid, e) => {
    if (e) e.stopPropagation();
    const d = downloads.find(x => x.gid === gid);
    if (!d) return;
    const filename = getFileName(d);
    try {
        const data = await callApi('/api/stream', { filename });
        if (data.error) alert('Error: ' + data.error);
    } catch(e) {
        alert('Failed to launch stream. Ensure the backend is running.');
    }
};

window.showInFinder = async (gid, e) => {
    if (e) e.stopPropagation();
    const d = downloads.find(x => x.gid === gid);
    const filepath = d?.files?.[0]?.path;
    if (!filepath) return alert("File path not found.");
    
    try {
        await callApi('/api/showInFinder', { filepath });
    } catch(e) {
        console.error(e);
    }
};

window.setGlobalSpeedLimit = async (speed) => {
    await client.call('changeGlobalOption', [{ 'max-overall-download-limit': speed }]).catch(() => {});
};

// --- DRAG AND DROP TORRENT SUPPORT ---
const dropZone = document.getElementById('dropZone');
const dropOverlay = document.getElementById('dropOverlay');

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropOverlay.classList.remove('hidden');
});

dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (e.target === dropOverlay) {
        dropOverlay.classList.add('hidden');
    }
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropOverlay.classList.add('hidden');

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.name.endsWith('.torrent')) {
            const reader = new FileReader();
            reader.onload = async (ev) => {
                const base64Str = ev.target.result.split(',')[1];
                await client.call('addTorrent', [base64Str]);
                refreshDownloads();
            };
            reader.readAsDataURL(file);
        } else {
            alert('Please drop a valid .torrent file.');
        }
    }
});

// Set up filter bar event listeners
document.getElementById('searchBar').addEventListener('input', renderDownloads);
document.getElementById('sortSelect').addEventListener('change', renderDownloads);
document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
    const confirmClear = confirm("Are you sure you want to clear all completed, failed, and stopped downloads from your history list? This will NOT delete any completed files on your disk.");
    if (!confirmClear) return;
    try {
        const res = await callApi('/api/history/clear-completed');
        if (res.success) {
            refreshDownloads();
        }
    } catch(e) {
        console.error("Failed to clear history", e);
    }
});


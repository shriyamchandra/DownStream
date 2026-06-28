const defaultInterceptTypes = [
    // Video
    'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mpg', 'mpeg',
    // Audio
    'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'alac',
    // Archive / Compression
    'zip', 'rar', 'tar', 'gz', '7z', 'bz2', 'xz', 'iso', 'img', 'cab', 'z', 'jar',
    // Disk Images & Installers & Executables
    'dmg', 'pkg', 'bin', 'exe', 'msi', 'apk', 'app',
    // Documents & E-books
    'pdf', 'epub', 'mobi', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    // Torrents
    'torrent'
];

// Deduplication: don't send same URL twice within 5s
const recentlyHandled = new Map();

function alreadyHandled(url) {
    const now = Date.now();
    if (recentlyHandled.has(url) && now - recentlyHandled.get(url) < 5000) return true;
    recentlyHandled.set(url, now);
    return false;
}

let cachedServerPort = 3000;

const detectedStreams = new Map(); // tabId -> Set of stream URLs

chrome.tabs.onRemoved.addListener((tabId) => {
    detectedStreams.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        detectedStreams.delete(tabId);
    }
});

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.url.includes('localhost') || details.url.includes('127.0.0.1')) return;
        
        const url = details.url;
        if (url.includes('.m3u8') || url.includes('.mpd')) {
            if (!url.includes('-fragment') && !url.includes('_fragment')) {
                if (details.tabId && details.tabId > 0) {
                    let set = detectedStreams.get(details.tabId);
                    if (!set) {
                        set = new Set();
                        detectedStreams.set(details.tabId, set);
                    }
                    if (set.size < 15) {
                        set.add(url);
                    }
                }
            }
        }
    },
    { urls: ['<all_urls>'] }
);

async function getServerPort() {
    try {
        const data = await chrome.storage.local.get('serverPort');
        if (data.serverPort) {
            const res = await fetch(`http://localhost:${data.serverPort}/api/ping`, { signal: AbortSignal.timeout(800) });
            if (res.ok) {
                cachedServerPort = data.serverPort;
                return cachedServerPort;
            }
        }
    } catch (e) {}

    for (const port of [3000, 3999, 8080, 4000]) {
        try {
            const res = await fetch(`http://localhost:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
            if (res.ok) {
                const json = await res.json();
                const detectedPort = json.webPort || port;
                await chrome.storage.local.set({ serverPort: detectedPort });
                cachedServerPort = detectedPort;
                return detectedPort;
            }
        } catch (e) {}
    }
    return cachedServerPort;
}

function isInternalUrl(url) {
    if (!url) return true;
    const isLocal = url.includes('localhost:') || url.includes('127.0.0.1');
    return url.startsWith('chrome:') || url.startsWith('about:') ||
           url.startsWith('javascript:') || url.startsWith('chrome-extension:') ||
           isLocal;
}

function getExt(filename, url) {
    if (filename) {
        const p = filename.split('.'); if (p.length > 1) return p.pop().toLowerCase();
    }
    let pathPart = url || '';
    try {
        pathPart = new URL(url).pathname;
    } catch (e) {
        pathPart = (url || '').split('?')[0].split('#')[0];
    }
    const segment = pathPart.split('/').pop() || '';
    const dot = segment.lastIndexOf('.');
    return dot > -1 ? segment.slice(dot + 1).toLowerCase() : '';
}

function isAllowedMime(mime) {
    if (!mime) return false;
    const m = mime.toLowerCase();
    return m.startsWith('video/') || m.startsWith('audio/') ||
           m.includes('zip') || m.includes('rar') || m.includes('compressed') ||
           m === 'application/octet-stream' || m === 'application/x-msdownload' ||
           m === 'application/x-apple-diskimage' || m === 'application/x-bittorrent' ||
           m === 'application/pdf' || m === 'application/epub+zip' ||
           m === 'application/x-mobipocket-ebook' || m === 'application/msword' ||
           m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
           m === 'application/vnd.ms-excel' || m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
           m === 'application/vnd.ms-powerpoint' || m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.set({ enabled: true, interceptTypes: defaultInterceptTypes });
    console.log('[Aria2] Extension installed/updated, defaults set.');
});

// ── Core: send to DownStream app ──────────────────────────────
async function sendToAria2(url, filename, referrer, cookiesString = '') {
    if (recentlyHandled.has(url) && Date.now() - recentlyHandled.get(url) < 5000) {
        console.log('[Aria2] Dedup skip:', url);
        return true;
    }
    recentlyHandled.set(url, Date.now());

    console.log('[Aria2] ✅ Sending to app:', url, '| file:', filename);

    const payload = { url, filename: filename || '', referrer: referrer || '', userAgent: navigator.userAgent, cookies: cookiesString };

    async function tryPost() {
        const port = await getServerPort();
        const res = await fetch(`http://localhost:${port}/api/intercept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return res.json();
    }

    try {
        const data = await tryPost();
        if (data.success) {
            console.log('[Aria2] Queued GID:', data.gid);
            return true;
        }
        console.error('[Aria2] App error:', data.error);
        return false;
    } catch (err) {
        console.warn('[Aria2] App offline, attempting to launch via URL scheme...');
        let helperTabId = null;
        try {
            const tab = await chrome.tabs.create({ url: 'downstream://open', active: false });
            if (tab && tab.id) helperTabId = tab.id;
        } catch (e) {}

        // Close helper tab quickly to prevent navigation to Chrome error page
        await new Promise(r => setTimeout(r, 500));
        if (helperTabId) {
            try {
                await chrome.tabs.remove(helperTabId);
            } catch (e) {}
        }

        // Give the app an additional 2 seconds to launch and start listening
        await new Promise(r => setTimeout(r, 2000));

        try {
            const data = await tryPost();
            if (data.success) {
                console.log('[Aria2] Retry succeeded, GID:', data.gid);
                return true;
            }
            console.error('[Aria2] Retry app error:', data.error);
            return false;
        } catch (retryErr) {
            console.error('[Aria2] ❌ App still not reachable after launch attempt:', retryErr.message);
            return false;
        }
    }
}

// ── Strategy 1: Content script sends explicit download clicks ─
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'DOWNLOAD') {
        const referrer = sender.tab ? sender.tab.url : '';
        
        const payload = {
            url: msg.url,
            filename: msg.filename || '',
            referrer: msg.referrer || referrer || '',
            stream: msg.stream || false,
            formatId: msg.formatId || null,
            formatExt: msg.formatExt || null,
            isSplit: msg.isSplit || false
        };

        getServerPort()
            .then(port => {
                return fetch(`http://localhost:${port}/api/intercept`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            })
            .then(res => {
                if (!res.ok) {
                    throw new Error(`HTTP error! Status: ${res.status}`);
                }
                return res.json();
            })
            .then(data => sendResponse({ ok: data.success, error: data.error }))
            .catch(err => {
                console.error('[Background] DOWNLOAD failed:', err);
                sendResponse({ ok: false, error: String(err) });
            });
        
        return true; // async response
    }
    
    if (msg.type === 'GET_QUALITIES') {
        getServerPort()
            .then(port => {
                return fetch(`http://localhost:${port}/api/qualities`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: msg.url })
                });
            })
            .then(res => {
                if (!res.ok) {
                    throw new Error(`HTTP error! Status: ${res.status}`);
                }
                return res.json();
            })
            .then(data => sendResponse({ ok: data.success, data, error: data.error }))
            .catch(err => {
                console.error('[Background] GET_QUALITIES failed:', err);
                sendResponse({ ok: false, error: String(err) });
            });
        
        return true; // async response
    }

    if (msg.type === 'GET_DETECTED_STREAMS') {
        const streamsSet = detectedStreams.get(msg.tabId);
        sendResponse({ ok: true, streams: streamsSet ? Array.from(streamsSet) : [] });
        return true;
    }
});

// ── Strategy 2: Logger onCreated ──────────────────────────────
chrome.downloads.onCreated.addListener((item) => {
    console.log('[Aria2] onCreated logged:', item.url, '| mime:', item.mime, '| state:', item.state);
});

// ── Strategy 3: Consolidated onDeterminingFilename ───────────
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    console.log('[Aria2] onDeterminingFilename:', item.url, '| mime:', item.mime, '| filename:', item.filename);

    if (isInternalUrl(item.url)) { suggest(); return; }

    chrome.storage.local.get(['enabled', 'interceptTypes']).then((settings) => {
        if (!settings.enabled) { suggest(); return; }

        const mime = (item.mime || '').toLowerCase();
        if (mime === 'text/html' || mime === 'text/plain') { suggest(); return; }

        const allowedTypes = settings.interceptTypes || defaultInterceptTypes;
        const ext = getExt(item.filename, item.url);
        const shouldIntercept = allowedTypes.includes(ext) || isAllowedMime(mime);

        if (shouldIntercept) {
            // Check deduplication before doing any async processing or calling suggest()
            if (recentlyHandled.has(item.url) && Date.now() - recentlyHandled.get(item.url) < 5000) {
                console.log('[Aria2] Already handled (dedup skip in listener):', item.url);
                chrome.downloads.cancel(item.id, () => {
                    chrome.downloads.erase({ id: item.id });
                });
                suggest();
                return;
            }

            chrome.cookies.getAll({ url: item.url }).then(async (cookies) => {
                const cookiesString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                const filename = item.filename ? item.filename.split(/[/\\]/).pop() : '';
                
                const sent = await sendToAria2(item.url, filename, item.referrer || '', cookiesString);
                if (sent) {
                    chrome.downloads.cancel(item.id, () => {
                        chrome.downloads.erase({ id: item.id });
                    });
                }
                suggest();
            }).catch(async () => {
                const filename = item.filename ? item.filename.split(/[/\\]/).pop() : '';
                const sent = await sendToAria2(item.url, filename, item.referrer || '', '');
                if (sent) {
                    chrome.downloads.cancel(item.id, () => {
                        chrome.downloads.erase({ id: item.id });
                    });
                }
                suggest();
            });
        } else {
            suggest();
        }
    }).catch(() => suggest());

    return true; // async suggest
});

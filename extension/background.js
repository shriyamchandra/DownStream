const defaultInterceptTypes = [
    'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mpg', 'mpeg',
    'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'alac',
    'zip', 'rar', 'tar', 'gz', '7z', 'bz2', 'xz', 'iso', 'img', 'cab', 'z', 'jar',
    'dmg', 'pkg', 'bin', 'exe', 'msi', 'apk', 'app',
    'pdf', 'epub', 'mobi', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'torrent'
];

const recentlyHandled = new Map();
const MAX_HANDLED_ENTRIES = 500;

// Periodic cleanup of recentlyHandled cache to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [url, timestamp] of recentlyHandled) {
        if (now - timestamp > 30000) {
            recentlyHandled.delete(url);
        }
    }
    // Hard cap: evict oldest entries if map grows too large
    if (recentlyHandled.size > MAX_HANDLED_ENTRIES) {
        const entries = [...recentlyHandled.entries()].sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < entries.length - MAX_HANDLED_ENTRIES; i++) {
            recentlyHandled.delete(entries[i][0]);
        }
    }
}, 60000);

let cachedServerPort = 3000;

// Restore cached port from storage on service worker startup
chrome.storage.local.get('serverPort').then(data => {
    if (data.serverPort) cachedServerPort = data.serverPort;
}).catch(() => {});

const detectedStreams = new Map(); // tabId -> Set of stream URLs
const MAX_STREAM_TABS = 50;

chrome.tabs.onRemoved.addListener((tabId) => {
    detectedStreams.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || changeInfo.url) {
        detectedStreams.delete(tabId);
    }
});

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.url.includes('localhost') || details.url.includes('127.0.0.1')) return;
        
        const url = details.url;
        if (!url.includes('-fragment') && !url.includes('_fragment')) {
            if (details.tabId && details.tabId > 0) {
                let set = detectedStreams.get(details.tabId);
                if (!set) {
                    // Cap total tracked tabs
                    if (detectedStreams.size >= MAX_STREAM_TABS) {
                        const oldestKey = detectedStreams.keys().next().value;
                        detectedStreams.delete(oldestKey);
                    }
                    set = new Set();
                    detectedStreams.set(details.tabId, set);
                }
                if (set.size < 15) {
                    set.add(url);
                }
            }
        }
    },
    { urls: ['*://*/*.m3u8*', '*://*/*.mpd*'] }
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

    const ports = [3000, 3999, 8080, 4000];
    const pingPromises = ports.map(async (port) => {
        try {
            const res = await fetch(`http://localhost:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
            if (res.ok) {
                await res.json().catch(() => {});
                return { port, ok: true };
            }
        } catch (e) {}
        return { port, ok: false };
    });

    try {
        const results = await Promise.all(pingPromises);
        const successful = results.find(r => r.ok);
        if (successful) {
            await chrome.storage.local.set({ serverPort: successful.port });
            cachedServerPort = successful.port;
            return successful.port;
        }
    } catch (e) {}

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
        const p = filename.split('.');
        if (p.length > 1) {
            const ext = p.pop();
            if (ext) return ext.toLowerCase();
        }
    }
    let pathPart = url || '';
    try {
        pathPart = new URL(url).pathname;
    } catch (e) {
        pathPart = (url || '').split('?')[0].split('#')[0];
    }
    const segment = pathPart.split('/').pop() || '';
    const dot = segment.lastIndexOf('.');
    if (dot <= 0) return ''; // dot at 0 means ".hidden", no ext
    const ext = segment.slice(dot + 1);
    return ext ? ext.toLowerCase() : '';
}

function isAllowedMime(mime) {
    if (!mime) return false;
    const m = mime.toLowerCase();
    return m.startsWith('video/') || m.startsWith('audio/') ||
           m === 'application/zip' || m === 'application/x-zip-compressed' ||
           m === 'application/x-rar-compressed' || m === 'application/vnd.rar' ||
           m === 'application/x-7z-compressed' || m === 'application/gzip' ||
           m === 'application/x-tar' || m === 'application/x-bzip2' ||
           m === 'application/x-xz' || m === 'application/x-iso9660-image' ||
           m === 'application/octet-stream' || m === 'application/x-msdownload' ||
           m === 'application/x-apple-diskimage' || m === 'application/x-bittorrent' ||
           m === 'application/pdf' || m === 'application/epub+zip' ||
           m === 'application/x-mobipocket-ebook' || m === 'application/msword' ||
           m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
           m === 'application/vnd.ms-excel' || m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
           m === 'application/vnd.ms-powerpoint' || m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
}

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.storage.local.set({ enabled: true, interceptTypes: defaultInterceptTypes });
        console.log('[Aria2] Extension installed, defaults set.');
    }
});

async function sendToAria2(url, filename, referrer, cookiesString = '') {
    if (recentlyHandled.has(url) && Date.now() - recentlyHandled.get(url) < 5000) {
        console.log('[Aria2] Dedup skip:', url);
        return true;
    }
    recentlyHandled.set(url, Date.now());

    console.log('[Aria2] Sending to app:', url, '| file:', filename);


    const payload = { url, filename: filename || '', referrer: referrer || '', cookies: cookiesString };

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

        await new Promise(r => setTimeout(r, 500));
        if (helperTabId) {
            try {
                await chrome.tabs.remove(helperTabId);
            } catch (e) {}
        }

        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 500));
            try {
                const data = await tryPost();
                if (data.success) {
                    console.log('[Aria2] Retry succeeded after app launch, GID:', data.gid);
                    return true;
                }
                console.error('[Aria2] Retry app error:', data.error);
                return false;
            } catch (retryErr) {
                if (i === 14) {
                    console.error('[Aria2] App still not reachable after launch attempt:', retryErr.message);
                }
            }
        }
        return false;
    }
}

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
        
        return true;
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
        
        return true;
    }

    if (msg.type === 'GET_DETECTED_STREAMS') {
        const streamsSet = detectedStreams.get(msg.tabId);
        sendResponse({ ok: true, streams: streamsSet ? Array.from(streamsSet) : [] });
        return true;
    }

    if (msg.type === 'SCHEDULE') {
        getServerPort()
            .then(port => {
                return fetch(`http://localhost:${port}/api/schedule`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: msg.url,
                        filename: msg.filename || '',
                        referrer: msg.referrer || '',
                        scheduledTime: msg.scheduledTime
                    })
                });
            })
            .then(res => res.json())
            .then(data => sendResponse({ ok: data.success, error: data.error }))
            .catch(err => {
                console.error('[Background] SCHEDULE failed:', err);
                sendResponse({ ok: false, error: String(err) });
            });
        return true;
    }
});

async function getDownloadMetadata(item) {
    const urlsToQuery = [];
    if (item.url) urlsToQuery.push(item.url);
    if (item.referrer) urlsToQuery.push(item.referrer);
    
    let activeTabUrl = '';
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs[0] && tabs[0].url) {
            activeTabUrl = tabs[0].url;
            urlsToQuery.push(activeTabUrl);
        }
    } catch (e) {}

    const resolvedReferrer = item.referrer || activeTabUrl || '';

    const allCookies = [];
    const seen = new Set();
    for (const url of urlsToQuery) {
        try {
            const cookies = await chrome.cookies.getAll({ url });
            for (const c of cookies) {
                const key = `${c.name}=${c.value}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    allCookies.push(key);
                }
            }
        } catch (e) {}
    }
    return {
        cookiesString: allCookies.join('; '),
        referrer: resolvedReferrer
    };
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    console.log('[Aria2] onDeterminingFilename:', item.url, '| mime:', item.mime, '| filename:', item.filename);

    if (isInternalUrl(item.url)) {
        suggest();
        return false;
    }

    chrome.storage.local.get(['enabled', 'interceptTypes']).then(settings => {
        if (!settings.enabled) {
            suggest();
            return;
        }

        const mime = (item.mime || '').toLowerCase();
        if (mime === 'text/html' || mime === 'text/plain') {
            suggest();
            return;
        }

        const ext = getExt(item.filename, item.url);
        const allowedTypes = settings.interceptTypes || defaultInterceptTypes;
        const shouldIntercept = allowedTypes.includes(ext) || isAllowedMime(mime);

        if (shouldIntercept) {
            // Don't call suggest() — cancels the Chrome download
            console.log('[Aria2] Intercepting download:', item.url);
            interceptDownload(item);
        } else {
            suggest();
        }
    }).catch(() => suggest());

    return true; // async — suggest() called from the promise
});

async function interceptDownload(item) {
    if (!item || isInternalUrl(item.url)) return;

    if (recentlyHandled.has(item.url) && Date.now() - recentlyHandled.get(item.url) < 5000) {
        chrome.downloads.cancel(item.id, () => {
            chrome.downloads.erase({ id: item.id }, () => {
                if (chrome.runtime.lastError) {}
            });
        });
        return;
    }
    recentlyHandled.set(item.url, Date.now());

    // Cancel in Chrome (may already be cancelled if onDeterminingFilename handled it)
    chrome.downloads.cancel(item.id, () => {
        chrome.downloads.erase({ id: item.id }, () => {
            if (chrome.runtime.lastError) {}
        });
    });

    try {
        const meta = await getDownloadMetadata(item);
        const filename = item.filename ? item.filename.split(/[/\\]/).pop() : '';
        await sendToAria2(item.url, filename, meta.referrer, meta.cookiesString);
    } catch (err) {
        const filename = item.filename ? item.filename.split(/[/\\]/).pop() : '';
        await sendToAria2(item.url, filename, item.referrer || '', '');
    }
}

// Fallback: onDeterminingFilename handles primary interception.
// onCreated catches downloads that bypass onDeterminingFilename (e.g. extension-initiated via chrome.downloads.download).
chrome.downloads.onCreated.addListener(async (item) => {
    // Skip if onDeterminingFilename already handled this URL
    if (recentlyHandled.has(item.url)) return;
    if (isInternalUrl(item.url)) return;
    const settings = await chrome.storage.local.get(['enabled', 'interceptTypes']);
    if (!settings.enabled) return;

    const mime = (item.mime || '').toLowerCase();
    if (mime === 'text/html' || mime === 'text/plain') return;

    const ext = getExt(item.filename, item.url);
    const allowedTypes = settings.interceptTypes || defaultInterceptTypes;
    if (!(allowedTypes.includes(ext) || isAllowedMime(mime))) return;

    console.log('[Aria2] onCreated fallback intercepting:', item.url);
    try {
        await interceptDownload(item);
    } catch (e) {
        console.error('[Aria2] onCreated listener error:', e);
    }
});

// Only catch intentionally-resumed downloads (paused -> in_progress).
// New downloads also trigger onChanged (no previous state), so we must check
// that the previous state was explicitly 'paused' to avoid hijacking new downloads
// or re-intercepting ones already handled by onDeterminingFilename/onCreated.
chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta.state) return;
    if (delta.state.current !== 'in_progress') return;
    // Only intercept if the download was previously paused (user clicked resume)
    if (delta.state.previous !== 'paused') return;

    try {
        const items = await chrome.downloads.search({ id: delta.id });
        const item = items?.[0];
        if (item && !recentlyHandled.has(item.url)) {
            console.log('[Aria2] Intercepting resumed download:', item.url);
            await interceptDownload(item);
        }
    } catch (e) {
        console.error('[Aria2] onChanged listener error:', e);
    }
});

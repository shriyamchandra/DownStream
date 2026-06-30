const defaultInterceptTypes = [
    'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mpg', 'mpeg',
    'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'alac',
    'zip', 'rar', 'tar', 'gz', '7z', 'bz2', 'xz', 'iso', 'img', 'cab', 'z', 'jar',
    'dmg', 'pkg', 'bin', 'exe', 'msi', 'apk', 'app',
    'pdf', 'epub', 'mobi', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'torrent'
];

const recentlyHandled = new Map();

// Periodic cleanup of recentlyHandled cache to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [url, timestamp] of recentlyHandled) {
        if (now - timestamp > 30000) {
            recentlyHandled.delete(url);
        }
    }
}, 60000);

let keepAliveInterval = null;

function keepAlive() {
    if (keepAliveInterval) return;
    keepAliveInterval = setInterval(() => {
        try {
            chrome.runtime.getPlatformInfo(() => {});
        } catch (e) {}
    }, 20000);
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

async function withKeepAlive(fn) {
    keepAlive();
    try {
        return await fn();
    } finally {
        stopKeepAlive();
    }
}

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
                const json = await res.json();
                return { port: json.webPort || port, ok: true };
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

async function sendToAria2(url, filename, referrer, cookiesString = '') {
    return withKeepAlive(async () => {
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

            await new Promise(r => setTimeout(r, 500));
            if (helperTabId) {
                try {
                    await chrome.tabs.remove(helperTabId);
                } catch (e) {}
            }

            // Poll API readiness up to 15 times (every 500ms -> up to 7.5s) to allow app/aria2 to start up
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
                    // Keep polling if app is still starting up
                    if (i === 14) {
                        console.error('[Aria2] ❌ App still not reachable after launch attempt:', retryErr.message);
                    }
                }
            }
            return false;
        }
    });
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
});

chrome.downloads.onCreated.addListener((item) => {
    console.log('[Aria2] onCreated logged:', item.url, '| mime:', item.mime, '| state:', item.state);
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
    suggest();
    return true;
});

chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta.state) return;
    if (delta.state.current !== 'in_progress') return;

    try {
        const items = await chrome.downloads.search({ id: delta.id });
        const item = items?.[0];
        if (!item || isInternalUrl(item.url)) return;

        const settings = await chrome.storage.local.get(['enabled', 'interceptTypes']);
        if (!settings.enabled) return;

        const mime = (item.mime || '').toLowerCase();
        if (mime === 'text/html' || mime === 'text/plain') return;

        const allowedTypes = settings.interceptTypes || defaultInterceptTypes;
        const ext = getExt(item.filename, item.url);
        const shouldIntercept = allowedTypes.includes(ext) || isAllowedMime(mime);

        if (shouldIntercept) {
            if (recentlyHandled.has(item.url) && Date.now() - recentlyHandled.get(item.url) < 5000) {
                chrome.downloads.cancel(item.id, () => {
                    chrome.downloads.erase({ id: item.id }, () => {
                        if (chrome.runtime.lastError) {}
                    });
                });
                return;
            }
            recentlyHandled.set(item.url, Date.now());

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
    } catch (e) {
        console.error('[Aria2] onChanged listener error:', e);
    }
});

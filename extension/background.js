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

function isInternalUrl(url) {
    return !url || url.startsWith('chrome:') || url.startsWith('about:') ||
           url.startsWith('javascript:') || url.startsWith('chrome-extension:') ||
           url.includes('localhost:3000') || url.includes('localhost:6800') ||
           url.includes('127.0.0.1');
}

function getExt(filename, url) {
    if (filename) {
        const p = filename.split('.'); if (p.length > 1) return p.pop().toLowerCase();
    }
    // Parse only the last path segment of the URL — never the domain — otherwise a
    // URL like "https://example.com/download" yields "com/download" instead of "".
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

// ─────────────────────────────────────────────────────────────
// Core: send to DownStream app
// ─────────────────────────────────────────────────────────────
async function sendToAria2(url, filename, referrer) {
    if (alreadyHandled(url)) {
        console.log('[Aria2] Dedup skip:', url);
        return;
    }
    console.log('[Aria2] ✅ Sending to app:', url, '| file:', filename);

    let cookiesString = '';
    try {
        const cookies = await chrome.cookies.getAll({ url });
        cookiesString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    } catch (e) {}

    const payload = { url, filename: filename || '', referrer: referrer || '', userAgent: navigator.userAgent, cookies: cookiesString };

    async function tryPost() {
        const res = await fetch('http://localhost:3000/api/intercept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return res.json();
    }

    try {
        const data = await tryPost();
        if (data.success) console.log('[Aria2] Queued GID:', data.gid);
        else console.error('[Aria2] App error:', data.error);
    } catch (err) {
        // App not running — launch it via custom URL scheme, then retry
        console.warn('[Aria2] App offline, attempting to launch via URL scheme...');
        try {
            // Open the app using its registered URL scheme
            await chrome.tabs.create({ url: 'downstream://open', active: false });
        } catch (e) {}

        // Wait 4 seconds for the app to boot, then retry once
        await new Promise(r => setTimeout(r, 4000));
        try {
            // Close the helper tab if it's still open
            const tabs = await chrome.tabs.query({ url: 'downstream://*' });
            for (const t of tabs) chrome.tabs.remove(t.id);
        } catch (e) {}

        try {
            const data = await tryPost();
            if (data.success) console.log('[Aria2] Retry succeeded, GID:', data.gid);
            else console.error('[Aria2] Retry app error:', data.error);
        } catch (retryErr) {
            console.error('[Aria2] ❌ App still not reachable after launch attempt:', retryErr.message);
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Strategy 1: Content script sends explicit download clicks
// ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.action === 'download') {
        console.log('[Aria2] Click intercepted from content.js:', message.url);
        const referrer = sender.tab ? sender.tab.url : '';
        sendToAria2(message.url, message.filename || '', referrer);
    }
});

// ─────────────────────────────────────────────────────────────
// Strategy 2: onCreated — fires immediately when Chrome starts
// ANY download (even from JS fetch, blob, redirect chains).
// Immediately cancel + erase, then decide via MIME/ext.
// ─────────────────────────────────────────────────────────────
chrome.downloads.onCreated.addListener(async (item) => {
    console.log('[Aria2] onCreated fired:', item.url, '| mime:', item.mime, '| filename:', item.filename, '| state:', item.state);

    if (isInternalUrl(item.url)) return;

    const settings = await chrome.storage.local.get(['enabled', 'interceptTypes']);
    if (!settings.enabled) return;

    const mime = (item.mime || '').toLowerCase();

    // Skip plain webpages
    if (mime === 'text/html' || mime === 'text/plain') {
        console.log('[Aria2] onCreated: skipping text/html page');
        return;
    }

    const allowedTypes = settings.interceptTypes || defaultInterceptTypes;
    const ext = getExt(item.filename, item.url);
    const shouldIntercept = allowedTypes.includes(ext) || isAllowedMime(mime);

    console.log('[Aria2] onCreated decision — ext:', ext, '| mime:', mime, '| intercept:', shouldIntercept);

    if (shouldIntercept) {
        // Cancel immediately so Chrome doesn't download it
        chrome.downloads.cancel(item.id, () => {
            chrome.downloads.erase({ id: item.id });
        });
        const filename = item.filename ? item.filename.split(/[/\\]/).pop() : '';
        sendToAria2(item.url, filename, item.referrer || '');
    }
});

// ─────────────────────────────────────────────────────────────
// Strategy 3: onDeterminingFilename — fires after redirects
// resolved. Catches cases where onCreated missed MIME info.
// ─────────────────────────────────────────────────────────────
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
            chrome.downloads.cancel(item.id);
            setTimeout(() => chrome.downloads.erase({ id: item.id }), 200);
            const filename = item.filename ? item.filename.split(/[/\\]/).pop() : '';
            sendToAria2(item.url, filename, item.referrer || '');
        } else {
            suggest();
        }
    }).catch(() => suggest());

    return true;
});

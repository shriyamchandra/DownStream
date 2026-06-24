const knownExtensions = [
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

function getExt(href) {
    // Only inspect the last path segment, never the domain — otherwise a URL like
    // "https://example.com/download" would yield "com/download" instead of "".
    let path = href || '';
    try {
        path = new URL(href).pathname;
    } catch (e) {
        path = (href || '').split('?')[0].split('#')[0];
    }
    const segment = path.split('/').pop() || '';
    const dot = segment.lastIndexOf('.');
    return dot > -1 ? segment.slice(dot + 1).toLowerCase() : '';
}

function isDownloadAnchor(anchor, href) {
    // Explicit download attribute — the page itself is declaring this a file download.
    if (anchor.hasAttribute('download')) return true;

    // A real, known file extension in the URL path (e.g. .mp4, .zip, .dmg).
    if (knownExtensions.includes(getExt(href))) return true;

    // Anything else (links labeled "Download", class/id containing "download", etc.)
    // is left alone. Those are usually navigation to a landing page, not a real file.
    // Genuine downloads triggered by such links are still caught by Chrome's own
    // chrome.downloads events in background.js, which check the actual MIME type.
    return false;
}

document.addEventListener('click', (e) => {
    const anchor = e.target.closest('a[href]');
    if (!anchor) return;

    const href = anchor.href;
    if (!href || href.startsWith('javascript:') ||
        href.includes('localhost:') || href.includes('127.0.0.1')) return;

    if (!isDownloadAnchor(anchor, href)) return;

    e.preventDefault();
    e.stopPropagation();

    chrome.runtime.sendMessage({
        action: 'download',
        url: href,
        filename: anchor.getAttribute('download') || ''
    });

    showToast('Sending to DownStream...');
}, true);

function showToast(message) {
    let toast = document.getElementById('downstream-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'downstream-toast';
        Object.assign(toast.style, {
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
            color: '#e1e1e1',
            border: '1px solid #0a84ff',
            padding: '12px 20px',
            borderRadius: '10px',
            boxShadow: '0 4px 24px rgba(10,132,255,0.3)',
            zIndex: '2147483647',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            fontSize: '0.85rem',
            fontWeight: '500',
            transition: 'opacity 0.3s ease',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
        });
        document.body.appendChild(toast);
    }
    toast.innerHTML = `<span style="font-size:1rem">⬇️</span> ${message}`;
    toast.style.opacity = '1';
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

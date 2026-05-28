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
    const clean = (href || '').split('?')[0].split('#')[0];
    const parts = clean.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function isDownloadAnchor(anchor, href) {
    // Explicit download attribute
    if (anchor.hasAttribute('download')) return true;

    // Check URL extension
    if (knownExtensions.includes(getExt(href))) return true;

    // Check if the link text / class / id hints it's a download button
    const text = (anchor.innerText || '').toLowerCase().trim();
    const cls = (anchor.className || '').toLowerCase();
    const id = (anchor.id || '').toLowerCase();
    const isDownloadLabel =
        text === 'download' ||
        text === 'free download' ||
        text === 'download free' ||
        cls.includes('download') ||
        id.includes('download');

    // Only intercept labeled download buttons if they don't point to a webpage
    if (isDownloadLabel) {
        const ext = getExt(href);
        // Don't intercept if the link points to an HTML page
        if (['html', 'htm', 'php', 'asp', 'aspx', ''].includes(ext)) {
            // If there's no extension, allow it only if it has download attribute
            return anchor.hasAttribute('download');
        }
        return true;
    }

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

    showToast('Sending to Aria2 Streamer...');
}, true);

function showToast(message) {
    let toast = document.getElementById('aria2-streamer-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'aria2-streamer-toast';
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

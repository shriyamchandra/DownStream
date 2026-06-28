const STREAM_BUFFER_THRESHOLD = 200000; // 200 KB buffer before streaming allowed

const VIDEO_EXTS = [
    'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mpg', 'mpeg',
    'm2ts', 'mts', 'mxf', 'vob', 'ogv', 'rm', 'rmvb', 'divx', 'hevc', 'h264'
];

const AUDIO_EXTS = [
    'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'alac'
];

const ARCHIVE_EXTS = [
    'zip', 'rar', 'tar', 'gz', '7z', 'bz2', 'xz', 'iso', 'img', 'cab', 'z', 'jar',
    'dmg', 'pkg', 'bin', 'exe', 'msi', 'apk', 'app'
];

const DOCUMENT_EXTS = [
    'pdf', 'epub', 'mobi', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'
];

const TORRENT_EXTS = [
    'torrent'
];

const ALL_INTERCEPT_EXTS = [
    ...VIDEO_EXTS,
    ...AUDIO_EXTS,
    ...ARCHIVE_EXTS,
    ...DOCUMENT_EXTS,
    ...TORRENT_EXTS
];

function getFileExtension(filename, url) {
    if (filename) {
        const parts = filename.split('.');
        if (parts.length > 1) return parts.pop().toLowerCase();
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

function getFilenameFromUrl(url, fallback = 'large_file') {
    if (!url) return fallback;
    let pathPart = '';
    try {
        pathPart = new URL(url).pathname;
    } catch (e) {
        pathPart = (url || '').split('?')[0].split('#')[0];
    }
    const raw = pathPart.split('/').pop() || fallback;
    try {
        return decodeURIComponent(raw) || fallback;
    } catch (e) {
        return raw;
    }
}

function isVideoFile(filename) {
    if (!filename) return false;
    const ext = filename.split('.').pop().toLowerCase();
    return VIDEO_EXTS.includes(ext) || ext === 'm3u8';
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

function getFileCategory(ext) {
    if (VIDEO_EXTS.includes(ext) || ext === 'm3u8') return 'video';
    if (AUDIO_EXTS.includes(ext)) return 'audio';
    if (ARCHIVE_EXTS.includes(ext)) return 'archive';
    if (DOCUMENT_EXTS.includes(ext)) return 'document';
    if (TORRENT_EXTS.includes(ext)) return 'torrent';
    return 'file';
}

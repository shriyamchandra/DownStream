// Pure presentation helpers and classifiers — no app state, no DOM.
import { VIDEO_EXTS, getFilenameFromUrl, getFileCategory } from './shared-constants.js';

// Escape untrusted text (filenames, URLs, error messages — all attacker-influenced
// via the download source) before interpolating into innerHTML, to prevent XSS.
export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function formatBytes(bytes) {
    if (bytes == 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatTime(seconds) {
    if (seconds === Infinity || seconds === 0 || isNaN(seconds)) return '--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

export function getFileName(d) {
    if (d.bittorrent && d.bittorrent.info && d.bittorrent.info.name) {
        return d.bittorrent.info.name;
    }
    if (d.files && d.files.length > 0) {
        if (d.files[0].path) {
            return d.files[0].path.split('/').pop();
        } else if (d.files[0].uris && d.files[0].uris.length > 0) {
            return getFilenameFromUrl(d.files[0].uris[0].uri, 'downloaded_file');
        }
    }
    return 'Unknown File';
}

export function isVideoFile(filename) {
    if (!filename) return false;
    const ext = filename.split('.').pop().toLowerCase();
    return VIDEO_EXTS.includes(ext) || ext === 'm3u8';
}

export function getStatusClass(status) {
    if (status === 'active' || status === 'waiting' || status === 'merging') return 'status-active';
    if (status === 'paused') return 'status-paused';
    if (status === 'complete') return 'status-complete';
    return 'status-error';
}

export function getStatusText(status) {
    if (status === 'active') return 'Downloading';
    if (status === 'waiting') return 'Waiting';
    if (status === 'paused') return 'Paused';
    if (status === 'complete') return 'Complete';
    if (status === 'error') return 'Failed';
    if (status === 'removed') return 'Cancelled';
    if (status === 'merging') return 'Merging...';
    return status;
}

export function getFileIconClass(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const cat = getFileCategory(ext);
    if (cat === 'video') return 'video';
    if (cat === 'audio') return 'audio';
    if (cat === 'archive') return 'zip';
    if (ext === 'pdf') return 'pdf';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) return 'image';
    return 'doc'; // default
}

export function getFileIconText(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (ext.length > 0 && ext.length <= 4) return ext.toUpperCase();
    return 'FILE';
}

// Inline SVG action icons.
export const iconPause = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
export const iconPlay = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
export const iconCancel = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
export const iconTrash = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
export const iconRestart = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg>`;
export const iconFolder = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;

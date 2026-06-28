const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'shared', 'shared-constants.js');

if (!fs.existsSync(SOURCE)) {
    console.error('Source shared-constants.js not found!');
    process.exit(1);
}

const content = fs.readFileSync(SOURCE, 'utf8');

// 1. Sync to Chrome Extension (plain JS, no exports)
const extPath = path.join(ROOT, 'extension', 'shared-constants.js');
fs.writeFileSync(extPath, content, 'utf8');
console.log('✓ Synced to Chrome Extension');

// 2. Sync to Frontend (ESM exports)
const esmContent = `${content}
export {
    STREAM_BUFFER_THRESHOLD,
    VIDEO_EXTS,
    AUDIO_EXTS,
    ARCHIVE_EXTS,
    DOCUMENT_EXTS,
    TORRENT_EXTS,
    ALL_INTERCEPT_EXTS,
    getFileExtension,
    getFilenameFromUrl,
    isVideoFile,
    isAllowedMime,
    getFileCategory
};
`;
const frontPath = path.join(ROOT, 'frontend', 'js', 'shared-constants.js');
fs.writeFileSync(frontPath, esmContent, 'utf8');
console.log('✓ Synced to Frontend (ESM)');

// 3. Sync to Backend (CommonJS exports)
const cjsContent = `${content}
if (typeof module !== 'undefined') {
    module.exports = {
        STREAM_BUFFER_THRESHOLD,
        VIDEO_EXTS,
        AUDIO_EXTS,
        ARCHIVE_EXTS,
        DOCUMENT_EXTS,
        TORRENT_EXTS,
        ALL_INTERCEPT_EXTS,
        getFileExtension,
        getFilenameFromUrl,
        isVideoFile,
        isAllowedMime,
        getFileCategory
    };
}
`;
const backPath = path.join(ROOT, 'backend', 'shared-constants.js');
fs.writeFileSync(backPath, cjsContent, 'utf8');
console.log('✓ Synced to Backend (CommonJS)');



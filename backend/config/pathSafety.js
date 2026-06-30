const path = require('path');
const fs = require('fs');
const os = require('os');

// resolve symlinks on the existing path prefix (subdirs that don't exist yet are skipped)
function getRealpath(targetPath) {
    let resolved = path.resolve(targetPath);
    let current = resolved;
    let suffix = '';
    while (current && current !== path.dirname(current)) {
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink()) {
                const linkTarget = fs.readlinkSync(current);
                const resolvedTarget = path.resolve(path.dirname(current), linkTarget);
                return getRealpath(path.join(resolvedTarget, suffix));
            }
        } catch (_) {}
        suffix = path.join(path.basename(current), suffix);
        current = path.dirname(current);
    }
    return resolved;
}

// download dir must be under Downloads/Desktop/Documents, app data, or a mounted volume
function isPathSafe(targetPath, appDataDir) {
    if (!targetPath) return false;
    
    const resolved = getRealpath(targetPath);
    const resolvedLower = resolved.toLowerCase();
    
    const allowedRoots = [
        path.join(os.homedir(), 'Downloads'),
        path.join(os.homedir(), 'Desktop'),
        path.join(os.homedir(), 'Documents')
    ].map(p => p.toLowerCase());
    
    if (appDataDir) {
        allowedRoots.push(appDataDir.toLowerCase());
    }
    
    for (const allowedRoot of allowedRoots) {
        if (resolvedLower === allowedRoot || resolvedLower.startsWith(allowedRoot + path.sep)) {
            return true;
        }
    }
    
    if (process.platform === 'darwin') {
        const volumes = '/volumes';
        if (resolvedLower.startsWith(volumes + path.sep)) {
            const parts = resolved.split(path.sep).filter(Boolean);
            if (parts.length >= 2) {
                return true;
            }
        }
    } else if (process.platform !== 'win32') {
        const media = '/media';
        const mnt = '/mnt';
        if (resolvedLower.startsWith(media + path.sep) || resolvedLower.startsWith(mnt + path.sep)) {
            const parts = resolved.split(path.sep).filter(Boolean);
            if (parts.length >= 2) {
                return true;
            }
        }
    }
    
    return false;
}

module.exports = {
    getRealpath,
    isPathSafe
};

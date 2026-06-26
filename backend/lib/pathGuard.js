const path = require('path');

// Guards file operations to within the configured download directory.
// Resolves ".." first, so paths like "<downloadDir>/../../../etc/passwd" can't
// escape the sandbox (a plain startsWith() check would let them through).
module.exports = function createPathGuard(config) {
    return {
        isWithin(targetPath) {
            if (!targetPath) return false;
            const base = path.resolve(config.data.downloadDir);
            const resolved = path.resolve(targetPath);
            return resolved === base || resolved.startsWith(base + path.sep);
        }
    };
};

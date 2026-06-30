const path = require('path');

// path.resolve before startsWith — plain prefix checks miss ../ traversal
module.exports = function createPathGuard(config) {
    return {
        isWithin(targetPath) {
            if (!targetPath) return false;
            const base = path.resolve(config.data.downloadDir).toLowerCase();
            const resolved = path.resolve(targetPath).toLowerCase();
            return resolved === base || resolved.startsWith(base + path.sep);
        }
    };
};

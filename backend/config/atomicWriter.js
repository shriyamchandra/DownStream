const fs = require('fs');

// write to .tmp then rename so a crash mid-write can't corrupt the target file
function writeJsonAtomicSync(filePath, obj) {
    const tmpPath = filePath + '.tmp';
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 4), 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        try {
            if (fs.existsSync(tmpPath)) {
                fs.unlinkSync(tmpPath);
            }
        } catch (_) {}
        throw err;
    }
}

module.exports = {
    writeJsonAtomicSync
};

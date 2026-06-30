const path = require('path');
const fs = require('fs');

const reservedFilenames = new Set();

function getUniqueFilename(dir, baseName) {
    let finalPath = path.join(dir, baseName);
    const ext = path.extname(baseName);
    const stem = baseName.slice(0, baseName.length - ext.length);
    let counter = 1;
    
    while (true) {
        if (reservedFilenames.has(finalPath)) {
            const candidate = `${stem} (${counter})${ext}`;
            finalPath = path.join(dir, candidate);
            counter++;
            continue;
        }
        
        try {
            const fd = fs.openSync(finalPath, 'wx');
            fs.closeSync(fd);
            reservedFilenames.add(finalPath);
            return finalPath;
        } catch (err) {
            if (err.code === 'EEXIST') {
                const candidate = `${stem} (${counter})${ext}`;
                finalPath = path.join(dir, candidate);
                counter++;
            } else {
                throw err;
            }
        }
    }
}

module.exports = {
    getUniqueFilename,
    reservedFilenames
};

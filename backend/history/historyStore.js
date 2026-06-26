const fs = require('fs');

// Repository for the persisted download history (history.json).
// Persists atomically (tmp + rename) so a crash mid-write can't corrupt the file,
// and never stores the volatile, live-only downloadSpeed.
module.exports = function createHistoryStore(config) {
    const historyPath = config.historyPath;
    let items = [];

    if (fs.existsSync(historyPath)) {
        try {
            items = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        } catch (e) {
            console.error('Failed to parse history.json, starting empty.');
        }
    } else {
        fs.writeFileSync(historyPath, JSON.stringify(items, null, 4));
    }

    function save() {
        try {
            const serializable = items.map(item => ({ ...item, downloadSpeed: 0 }));
            const tmpPath = historyPath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(serializable, null, 4));
            fs.renameSync(tmpPath, historyPath);
        } catch (e) {
            console.error('Failed to save history:', e);
        }
    }

    return {
        // Live array — callers may find/unshift/splice in place.
        get items() { return items; },
        // Replace the whole list (e.g. clear-completed filters it down).
        setItems(next) { items = next; },
        save
    };
};

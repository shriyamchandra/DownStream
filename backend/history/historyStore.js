const fs = require('fs');

module.exports = function createHistoryStore(config) {
    const historyPath = config.historyPath;
    let items = [];

    if (fs.existsSync(historyPath)) {
        try {
            items = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        } catch (e) {
            console.error('Failed to parse history.json, starting empty.');
            const corruptBackupPath = `${historyPath}.corrupt`;
            try {
                fs.copyFileSync(historyPath, corruptBackupPath);
                console.error(`Corrupt history file backed up to: ${corruptBackupPath}`);
            } catch (backupErr) {
                console.error('Failed to back up corrupt history file:', backupErr.message);
            }
        }
    } else {
        fs.writeFileSync(historyPath, JSON.stringify(items, null, 4));
    }

    let isSaving = false;
    let pendingSave = false;

    async function save() {
        if (isSaving) {
            pendingSave = true;
            return;
        }
        isSaving = true;
        try {
            const serializable = items.map(item => ({ ...item, downloadSpeed: 0 }));
            const tmpPath = historyPath + '.tmp';
            await fs.promises.writeFile(tmpPath, JSON.stringify(serializable, null, 4), 'utf8');
            await fs.promises.rename(tmpPath, historyPath);
        } catch (e) {
            console.error('Failed to save history:', e);
        } finally {
            isSaving = false;
            if (pendingSave) {
                pendingSave = false;
                setImmediate(save);
            }
        }
    }

    return {
        get items() { return items; },
        setItems(next) { items = next; },
        save
    };
};

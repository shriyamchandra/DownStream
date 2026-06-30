const path = require('path');
const os = require('os');

function resolveAppDataDir(fallbackDir) {
    const isElectron = !!(process.versions && process.versions.electron);
    if (isElectron) {
        try {
            const { app: electronApp } = require('electron');
            if (electronApp && typeof electronApp.getPath === 'function') {
                return electronApp.getPath('userData');
            }
        } catch (e) {
            console.error('Failed to get Electron userData path, using manual Electron fallback:', e);
        }
        
        const appName = 'DownStream';
        if (process.platform === 'darwin') {
            return path.join(os.homedir(), 'Library', 'Application Support', appName);
        } else if (process.platform === 'win32') {
            return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
        } else {
            return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
        }
    }
    return fallbackDir;
}

module.exports = {
    resolveAppDataDir
};

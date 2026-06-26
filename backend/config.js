const path = require('path');
const fs = require('fs');

// Resolve where writable files (config, session, history) live: the Electron
// userData dir when running inside Electron, otherwise the backend folder.
function resolveAppDataDir(fallbackDir) {
    try {
        const { app: electronApp } = require('electron');
        if (electronApp) return electronApp.getPath('userData');
    } catch (e) {
        // Standalone Node.js mode — fall through.
    }
    return fallbackDir;
}

// Owns application settings and the resolved filesystem paths, and is the single
// place that loads/persists config.json. `data` is a live object other modules
// read from (e.g. config.data.downloadDir) so updates are seen everywhere.
function createConfig() {
    const backendDir = __dirname;                  // .../backend
    const projectRoot = path.join(backendDir, '..');
    const appDataDir = resolveAppDataDir(backendDir);
    if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });

    const configPath = path.join(appDataDir, 'config.json');
    const sessionPath = path.join(appDataDir, 'aria2.session');
    const historyPath = path.join(appDataDir, 'history.json');

    const data = {
        preferredPlayer: 'vlc',
        downloadDir: path.join(process.env.HOME, 'Downloads', 'DownStream')
    };

    if (fs.existsSync(configPath)) {
        try {
            Object.assign(data, JSON.parse(fs.readFileSync(configPath, 'utf8')));
        } catch (e) {
            console.error('Failed to parse config.json, using defaults.');
        }
    } else {
        fs.writeFileSync(configPath, JSON.stringify(data, null, 4));
    }

    if (!fs.existsSync(data.downloadDir)) fs.mkdirSync(data.downloadDir, { recursive: true });
    if (!fs.existsSync(sessionPath)) fs.writeFileSync(sessionPath, '');

    function save() {
        fs.writeFileSync(configPath, JSON.stringify(data, null, 4));
    }

    // Apply a settings patch (known keys only), persist, and return current config.
    function update(patch = {}) {
        if (patch.preferredPlayer) data.preferredPlayer = patch.preferredPlayer;
        if (patch.downloadDir) {
            data.downloadDir = path.resolve(patch.downloadDir);
            if (!fs.existsSync(data.downloadDir)) fs.mkdirSync(data.downloadDir, { recursive: true });
        }
        save();
        return data;
    }

    return {
        data,
        backendDir,
        projectRoot,
        appDataDir,
        configPath,
        sessionPath,
        historyPath,
        webPort: parseInt(process.env.PORT || process.env.WEB_PORT || '3000', 10),
        aria2Port: parseInt(process.env.ARIA2_PORT || '6800', 10),
        maxHistory: 1000,
        save,
        update
    };
}

module.exports = createConfig;

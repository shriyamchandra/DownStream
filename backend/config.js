const path = require('path');
const fs = require('fs');
const os = require('os');


const { isPathSafe, getRealpath } = require('./config/pathSafety');
const { resolveAppDataDir } = require('./config/appPaths');
const { tryHealJson, extractKeysFromCorruptJson } = require('./config/recovery');
const { writeJsonAtomicSync } = require('./config/atomicWriter');

function createConfig() {
    const backendDir = __dirname;                  // .../backend
    const projectRoot = path.join(backendDir, '..');
    const appDataDir = resolveAppDataDir(backendDir);
    
    try {
        if (!fs.existsSync(appDataDir)) {
            fs.mkdirSync(appDataDir, { recursive: true });
        }
    } catch (e) {
        console.error(`Failed to create appDataDir ${appDataDir}:`, e);
    }

    const configPath = path.join(appDataDir, 'config.json');
    const sessionPath = path.join(appDataDir, 'aria2.session');
    const historyPath = path.join(appDataDir, 'history.json');

    const data = {
        preferredPlayer: 'vlc',
        downloadDir: path.join(os.homedir(), 'Downloads', 'DownStream'),
        youtubeCookiesBrowser: ''
    };

    if (fs.existsSync(configPath)) {
        const fileContent = fs.readFileSync(configPath, 'utf8');
        try {
            Object.assign(data, JSON.parse(fileContent));
        } catch (e) {
            console.error(`Failed to parse config.json at ${configPath}. Attempting recovery...`, e);
            
            let recoveredData = tryHealJson(fileContent);
            if (!recoveredData) {
                const extracted = extractKeysFromCorruptJson(fileContent);
                if (Object.keys(extracted).length > 0) {
                    recoveredData = extracted;
                }
            }
            
            if (recoveredData) {
                console.log('Successfully recovered settings from corrupt config:', recoveredData);
                Object.assign(data, recoveredData);
            } else {
                console.warn('Could not recover any settings from corrupt config. Using defaults.');
            }
            
            try {
                fs.renameSync(configPath, configPath + '.corrupt');
                writeJsonAtomicSync(configPath, data);
                console.log(`Corrupt config backed up to ${configPath}.corrupt`);
            } catch (backupErr) {
                console.error('Failed to write clean config after corruption:', backupErr);
            }
        }
    } else {
        try {
            writeJsonAtomicSync(configPath, data);
        } catch (e) {
            console.error('Failed to write initial config.json:', e);
        }
    }

    if (!isPathSafe(data.downloadDir, appDataDir)) {
        console.warn(`Default downloadDir "${data.downloadDir}" is unsafe. Falling back to a subfolder inside appDataDir.`);
        data.downloadDir = path.join(appDataDir, 'downloads');
    }

    try {
        if (fs.existsSync(data.downloadDir)) {
            const stats = fs.statSync(data.downloadDir);
            if (!stats.isDirectory()) {
                console.warn(`Path "${data.downloadDir}" exists but is not a directory. Falling back to a subfolder inside appDataDir.`);
                data.downloadDir = path.join(appDataDir, 'downloads');
                if (!fs.existsSync(data.downloadDir)) {
                    fs.mkdirSync(data.downloadDir, { recursive: true });
                }
            }
        } else {
            fs.mkdirSync(data.downloadDir, { recursive: true });
        }
    } catch (e) {
        console.error(`Failed to create downloadDir "${data.downloadDir}", falling back to appDataDir subfolder:`, e);
        data.downloadDir = path.join(appDataDir, 'downloads');
        try {
            if (!fs.existsSync(data.downloadDir)) {
                fs.mkdirSync(data.downloadDir, { recursive: true });
            }
        } catch (innerErr) {
            console.error('Failed to create fallback download directory:', innerErr);
        }
    }

    try {
        if (!fs.existsSync(sessionPath)) {
            fs.writeFileSync(sessionPath, '');
        }
    } catch (e) {
        console.error(`Failed to create session file at ${sessionPath}:`, e);
    }

    function save() {
        writeJsonAtomicSync(configPath, data);
    }

    function update(patch = {}) {
        if (patch.preferredPlayer !== undefined) {
            const player = patch.preferredPlayer;
            const validPlayers = ['vlc', 'mpv', 'iina', ''];
            if (!validPlayers.includes(player)) {
                throw new Error(`Invalid preferred player: "${player}". Valid options are: vlc, mpv, iina, or empty string (default).`);
            }
            data.preferredPlayer = player;
        }

        if (patch.downloadDir !== undefined) {
            const resolved = path.resolve(patch.downloadDir);
            if (!isPathSafe(resolved, appDataDir)) {
                throw new Error('Invalid download directory path: path must be inside standard folders (Downloads, Desktop, Documents) or external volumes, and not in sensitive system directories.');
            }
            try {
                const real = getRealpath(resolved);
                if (fs.existsSync(real)) {
                    const stats = fs.statSync(real);
                    if (!stats.isDirectory()) {
                        throw new Error('A file already exists at the target path');
                    }
                } else {
                    fs.mkdirSync(real, { recursive: true });
                }
            } catch (err) {
                throw new Error(`Failed to create download directory: ${err.message}`);
            }
            data.downloadDir = resolved;
        }

        if (patch.youtubeCookiesBrowser !== undefined) {
            data.youtubeCookiesBrowser = patch.youtubeCookiesBrowser;
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

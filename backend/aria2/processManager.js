const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Free a port by killing the process listening on it — but only if it looks like
// one of ours (node/electron/aria2c), so we don't kill an unrelated service.
function freePort(port) {
    try {
        const pids = execSync(`lsof -t -i:${port}`).toString().trim().split('\n').filter(Boolean);
        if (pids.length === 0) return;

        const targets = [];
        pids.forEach(pid => {
            try {
                const cmd = execSync(`ps -p ${pid} -o comm= 2>/dev/null || true`).toString().trim();
                if (cmd.includes('node') || cmd.includes('electron') || cmd.includes('aria2c') || cmd === '') {
                    targets.push(pid);
                } else {
                    console.log(`[Port Cleaner] Skipping non-target PID ${pid} (${cmd}) on port ${port}`);
                }
            } catch (e) {
                targets.push(pid); // if ps fails, be conservative
            }
        });

        if (targets.length > 0) {
            console.log(`[Port Cleaner] Port ${port} cleaning targets: ${targets.join(', ')}`);
            targets.forEach(pid => {
                try {
                    process.kill(parseInt(pid), 'SIGKILL');
                } catch (err) {
                    try { execSync(`kill -9 ${pid}`); } catch (e) {}
                }
            });
        }
    } catch (e) {
        // Port is free or lsof command failed/returned empty.
    }
}

// Locate the aria2c binary: packaged resource, bundled bin/, PATH, then Homebrew.
function locateAria2c(projectRoot) {
    const packagedPath = process.resourcesPath ? path.join(process.resourcesPath, 'aria2c') : '';
    const localPath = path.join(projectRoot, 'bin', 'aria2c');

    if (packagedPath && fs.existsSync(packagedPath)) return packagedPath;
    if (fs.existsSync(localPath)) return localPath;
    try {
        return execSync('which aria2c').toString().trim();
    } catch (e) {
        if (fs.existsSync('/opt/homebrew/bin/aria2c')) return '/opt/homebrew/bin/aria2c';
        if (fs.existsSync('/usr/local/bin/aria2c')) return '/usr/local/bin/aria2c';
    }
    return 'aria2c';
}

// Manages the aria2c daemon lifecycle (port cleanup, spawn, graceful shutdown).
module.exports = function createProcessManager(config) {
    let ariaProcess = null;

    function start() {
        // Free our ports first so a stale instance can't block startup.
        freePort(config.webPort);
        freePort(config.aria2Port);

        const aria2cPath = locateAria2c(config.projectRoot);
        const args = [
            '--enable-rpc=true',
            '--rpc-allow-origin-all=true',
            '--rpc-listen-all=true',
            `--rpc-listen-port=${config.aria2Port}`,
            `--dir=${config.data.downloadDir}`,
            '--stream-piece-selector=inorder',
            '--allow-overwrite=true',
            '-x', '16', '-s', '16', '-c',
            '--file-allocation=none',
            '--auto-file-renaming=false',
            `--input-file=${config.sessionPath}`,
            `--save-session=${config.sessionPath}`,
            '--save-session-interval=10'
        ];

        console.log(`Starting aria2c: ${aria2cPath} ${args.join(' ')}`);
        ariaProcess = spawn(aria2cPath, args, { stdio: 'inherit' });

        ariaProcess.on('error', (err) => {
            console.error('Failed to start aria2c. Make sure it is installed (brew install aria2).', err);
        });
        ariaProcess.on('exit', (code, signal) => {
            console.error(`aria2c exited unexpectedly (code=${code}, signal=${signal}). Downloads will stop working until restart.`);
        });

        return ariaProcess;
    }

    function cleanup() {
        console.log('Cleaning up aria2c process...');
        if (!ariaProcess) return;
        try {
            ariaProcess.kill('SIGINT');
            const killTimer = setTimeout(() => {
                try { ariaProcess.kill('SIGKILL'); } catch (e) { /* ignore on shutdown */ }
            }, 1500);
            ariaProcess.once('exit', () => clearTimeout(killTimer));
        } catch (e) {
            console.error('Error killing aria2c process:', e);
        }
    }

    return { start, cleanup, freePort };
};

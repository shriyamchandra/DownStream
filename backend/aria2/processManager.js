const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function cleanPreviousInstance(config) {
    const pidFilePath = path.join(config.appDataDir, 'pids.json');
    if (!fs.existsSync(pidFilePath)) return;

    try {
        const pids = JSON.parse(fs.readFileSync(pidFilePath, 'utf8'));
        
        // Attempt clean shutdown first (SIGTERM)
        if (pids.backend) {
            try { process.kill(parseInt(pids.backend, 10), 'SIGTERM'); } catch (e) {}
        }
        if (pids.aria2) {
            try { process.kill(parseInt(pids.aria2, 10), 'SIGTERM'); } catch (e) {}
        }

        // Wait up to 500ms for graceful shutdown
        let start = Date.now();
        while (Date.now() - start < 500) {
            let backendAlive = false;
            let ariaAlive = false;
            if (pids.backend) {
                try { process.kill(parseInt(pids.backend, 10), 0); backendAlive = true; } catch (e) {}
            }
            if (pids.aria2) {
                try { process.kill(parseInt(pids.aria2, 10), 0); ariaAlive = true; } catch (e) {}
            }
            if (!backendAlive && !ariaAlive) break;
        }

        // Force kill SIGKILL if still running
        if (pids.backend) {
            try {
                process.kill(parseInt(pids.backend, 10), 0);
                process.kill(parseInt(pids.backend, 10), 'SIGKILL');
            } catch (e) {}
        }
        if (pids.aria2) {
            try {
                process.kill(parseInt(pids.aria2, 10), 0);
                process.kill(parseInt(pids.aria2, 10), 'SIGKILL');
            } catch (e) {}
        }
    } catch (e) {
        console.error('[PID Manager] Error cleaning up previous instance PIDs:', e);
    }

    try {
        fs.unlinkSync(pidFilePath);
    } catch (e) {}
}

function recordPids(config, backendPid, aria2Pid) {
    const pidFilePath = path.join(config.appDataDir, 'pids.json');
    try {
        fs.writeFileSync(pidFilePath, JSON.stringify({ backend: backendPid, aria2: aria2Pid }));
    } catch (e) {
        console.error('[PID Manager] Failed to write pids.json:', e);
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
    let isShuttingDown = false;
    let restartAttempts = 0;
    const MAX_RESTART_ATTEMPTS = 5;
    const BASE_RESTART_DELAY_MS = 1000;

    // Non-blocking port wait: polls with setTimeout instead of blocking the event loop.
    function waitForPortFree(port, timeoutMs) {
        return new Promise(resolve => {
            const deadline = Date.now() + timeoutMs;
            function check() {
                try {
                    execSync(`lsof -i :${port}`, { stdio: 'ignore' });
                    // Port still in use — try again if we have time
                    if (Date.now() < deadline) {
                        setTimeout(check, 100);
                    } else {
                        resolve(); // timed out, proceed anyway
                    }
                } catch (e) {
                    resolve(); // lsof returned non-zero → port is free
                }
            }
            check();
        });
    }

    async function start() {
        isShuttingDown = false;
        // Free our ports first so a stale instance can't block startup.
        cleanPreviousInstance(config);

        // Wait up to 2 seconds for port to become free (non-blocking)
        await waitForPortFree(config.aria2Port, 2000);

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

        // Record our current PIDs
        recordPids(config, process.pid, ariaProcess.pid);

        ariaProcess.on('error', (err) => {
            console.error('Failed to start aria2c. Make sure it is installed (brew install aria2).', err);
        });

        ariaProcess.on('exit', (code, signal) => {
            if (isShuttingDown) {
                console.log('aria2c process exited gracefully on cleanup.');
                return;
            }

            restartAttempts++;
            if (restartAttempts > MAX_RESTART_ATTEMPTS) {
                console.error(
                    `aria2c has crashed ${restartAttempts} times. Giving up auto-restart. ` +
                    `Fix the underlying issue and relaunch the app.`
                );
                return;
            }

            const delay = Math.min(BASE_RESTART_DELAY_MS * Math.pow(2, restartAttempts - 1), 30000);
            console.error(
                `aria2c exited unexpectedly (code=${code}, signal=${signal}). ` +
                `Restart attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS} in ${delay}ms...`
            );
            setTimeout(() => {
                if (!isShuttingDown) {
                    start().catch(err => {
                        console.error('Failed to restart aria2c:', err);
                    });
                }
            }, delay);
        });

        // Reset the restart counter after aria2 has been running stably for 30s
        setTimeout(() => {
            if (ariaProcess && !ariaProcess.killed && !isShuttingDown) {
                restartAttempts = 0;
            }
        }, 30000);

        return ariaProcess;
    }

    function cleanup() {
        isShuttingDown = true;
        console.log('Cleaning up aria2c process...');
        const pidFilePath = path.join(config.appDataDir, 'pids.json');
        try {
            fs.unlinkSync(pidFilePath);
        } catch (e) {}

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

    return { start, cleanup };
};

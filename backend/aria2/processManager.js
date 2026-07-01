const { spawn, execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { writeJsonAtomicSync } = require('../config/atomicWriter');

async function cleanPreviousInstance(config) {
    const pidFilePath = path.join(config.appDataDir, 'pids.json');
    if (!fs.existsSync(pidFilePath)) return;

    try {
        const fileContent = fs.readFileSync(pidFilePath, 'utf8');
        const pids = JSON.parse(fileContent);
        
        // stale PID file — don't kill processes that may have reused these PIDs
        if (pids.timestamp && Date.now() - pids.timestamp > 15 * 60 * 1000) {
            console.log('[PID Manager] Stale PID file detected. Skipping signal termination.');
            try { fs.unlinkSync(pidFilePath); } catch (e) {}
            return;
        }

        if (pids.backend) {
            try { process.kill(parseInt(pids.backend, 10), 'SIGTERM'); } catch (e) {}
        }
        if (pids.aria2) {
            try { process.kill(parseInt(pids.aria2, 10), 'SIGTERM'); } catch (e) {}
        }

        const deadline = Date.now() + 500;
        while (Date.now() < deadline) {
            let backendAlive = false;
            let ariaAlive = false;
            if (pids.backend) {
                try { process.kill(parseInt(pids.backend, 10), 0); backendAlive = true; } catch (e) {}
            }
            if (pids.aria2) {
                try { process.kill(parseInt(pids.aria2, 10), 0); ariaAlive = true; } catch (e) {}
            }
            if (!backendAlive && !ariaAlive) break;
            await new Promise(r => setTimeout(r, 50));
        }

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
        writeJsonAtomicSync(pidFilePath, {
            backend: backendPid,
            aria2: aria2Pid,
            timestamp: Date.now()
        });
    } catch (e) {
        console.error('[PID Manager] Failed to write pids.json:', e);
    }
}

function locateAria2c(projectRoot) {
    const packagedPath = process.resourcesPath ? path.join(process.resourcesPath, 'aria2c') : '';
    const localPath = path.join(projectRoot, 'bin', 'aria2c');

    if (packagedPath && fs.existsSync(packagedPath)) return packagedPath;
    if (fs.existsSync(localPath)) return localPath;
    try {
        return execFileSync('which', ['aria2c'], { stdio: 'pipe' }).toString().trim();
    } catch (e) {
        if (fs.existsSync('/opt/homebrew/bin/aria2c')) return '/opt/homebrew/bin/aria2c';
        if (fs.existsSync('/usr/local/bin/aria2c')) return '/usr/local/bin/aria2c';
    }
    return 'aria2c';
}

function isPortFree(port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => {
            resolve(false);
        });
        server.once('listening', () => {
            server.close(() => {
                resolve(true);
            });
        });
        server.listen(port, '127.0.0.1');
    });
}

module.exports = function createProcessManager(config) {
    let ariaProcess = null;
    let isShuttingDown = false;
    let restartAttempts = 0;
    const MAX_RESTART_ATTEMPTS = 5;
    const BASE_RESTART_DELAY_MS = 1000;

    async function waitForPortFree(port, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const free = await isPortFree(port);
            if (free) return;
            await new Promise(r => setTimeout(r, 100));
        }
    }

    async function start() {
        isShuttingDown = false;
        restartAttempts = 0;
        await cleanPreviousInstance(config);
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

        // Apply bandwidth limit if configured (value in KB/s, aria2 expects bytes)
        if (config.data.maxDownloadSpeed > 0) {
            args.push(`--max-overall-download-limit=${config.data.maxDownloadSpeed}K`);
        }

        console.log(`Starting aria2c: ${aria2cPath} ${args.join(' ')}`);
        ariaProcess = spawn(aria2cPath, args, { stdio: 'inherit' });

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

        if (!ariaProcess || ariaProcess.killed || ariaProcess.exitCode !== null) {
            return Promise.resolve();
        }

        return new Promise(resolve => {
            try {
                const killTimer = setTimeout(() => {
                    try { ariaProcess.kill('SIGKILL'); } catch (e) { /* ignore on shutdown */ }
                    resolve();
                }, 1500);
                
                ariaProcess.once('exit', () => {
                    clearTimeout(killTimer);
                    resolve();
                });
                
                ariaProcess.kill('SIGINT');
            } catch (e) {
                console.error('Error killing aria2c process:', e);
                resolve();
            }
        });
    }

    return { start, cleanup };
};

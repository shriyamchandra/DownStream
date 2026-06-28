const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function findNodeRuntime(config) {
    // 1. Check if process.argv[0] is node and exists
    if (process.argv[0] && process.argv[0].includes('node') && !process.argv[0].includes('Electron') && !process.argv[0].includes('downstream')) {
        if (fs.existsSync(process.argv[0])) {
            return process.argv[0];
        }
    }
    // 2. Check local Node
    if (config && config.projectRoot) {
        const localNode = path.join(config.projectRoot, '.node-local', 'node-v22.13.0-darwin-arm64', 'bin', 'node');
        if (fs.existsSync(localNode)) {
            return localNode;
        }
    }
    // 3. Fallback: check if system 'node' is in PATH.
    // If not, return null so we don't pass the flag.
    const { execSync } = require('child_process');
    try {
        execSync('which node', { stdio: 'ignore' });
        return 'node';
    } catch (e) {
        return null;
    }
}

function execYtDlpJson(ytDlpPath, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ytDlpPath, args);
        let stdoutData = [];
        let stderrData = [];

        proc.stdout.on('data', (chunk) => {
            stdoutData.push(chunk);
        });

        proc.stderr.on('data', (chunk) => {
            stderrData.push(chunk);
        });

        proc.on('close', (code) => {
            const stdoutStr = Buffer.concat(stdoutData).toString('utf8');
            const stderrStr = Buffer.concat(stderrData).toString('utf8');

            if (code !== 0) {
                const err = new Error(`yt-dlp exited with code ${code}`);
                err.stderr = stderrStr;
                return reject(err);
            }

            try {
                const json = JSON.parse(stdoutStr);
                resolve({ json, stderr: stderrStr });
            } catch (e) {
                const err = new Error(`Failed to parse JSON: ${e.message}`);
                err.stdout = stdoutStr;
                err.stderr = stderrStr;
                reject(err);
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
}

function resolveStreamUrls(ytDlpPath, config, url, formatId, userAgent, cookiesBrowser) {
    const nodeRuntime = findNodeRuntime(config);
    
    let formatSpec = formatId;
    if (typeof formatId === 'string' && ['best', '4k', '2160p', '1080p', '720p', '480p'].includes(formatId)) {
        if (formatId === '4k' || formatId === '2160p') formatSpec = 'best[height<=2160]';
        else if (formatId === '1080p') formatSpec = 'best[height<=1080]';
        else if (formatId === '720p') formatSpec = 'best[height<=720]';
        else if (formatId === '480p') formatSpec = 'best[height<=480]';
        else formatSpec = 'bestvideo[height<=2160]+bestaudio/best[height<=2160]';
    }
    
    if (!formatSpec) {
        formatSpec = 'bestvideo[height<=2160]+bestaudio/best[height<=2160]';
    } else if (formatSpec !== 'best' && !formatSpec.includes('[height<=') && !formatSpec.includes('+') && !formatSpec.includes('bestaudio')) {
        formatSpec = `${formatSpec}+ba/best`;
    }

    const args = [
        '--ignore-config',
        '--no-warnings',
        '--no-check-formats',
        '--print', 'format_id',
        '--print', 'url',
        '-f', formatSpec,
        '--user-agent', userAgent
    ];
    if (config && config.appDataDir) {
        args.push('--cache-dir', path.join(config.appDataDir, 'yt-dlp-cache'));
    }
    if (nodeRuntime) {
        args.push('--js-runtimes', `node:${nodeRuntime}`);
    }
    if (cookiesBrowser) {
        args.push('--cookies-from-browser', cookiesBrowser);
    }
    args.push(url);

    return new Promise((resolve, reject) => {
        const proc = spawn(ytDlpPath, args);
        let stdoutData = [];
        let stderrData = [];

        proc.stdout.on('data', chunk => stdoutData.push(chunk));
        proc.stderr.on('data', chunk => stderrData.push(chunk));

        proc.on('close', (code) => {
            const stdoutStr = Buffer.concat(stdoutData).toString('utf8');
            const stderrStr = Buffer.concat(stderrData).toString('utf8');

            if (code !== 0) {
                const err = new Error(`yt-dlp exited with code ${code}`);
                err.stderr = stderrStr;
                return reject(err);
            }

            const lines = stdoutStr.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('WARNING:'));
            
            if (lines.length >= 4) {
                resolve({
                    videoFormatId: lines[0],
                    videoUrl: lines[1],
                    audioFormatId: lines[2],
                    audioUrl: lines[3]
                });
            } else if (lines.length >= 2) {
                resolve({
                    videoFormatId: lines[0],
                    videoUrl: lines[1],
                    audioFormatId: null,
                    audioUrl: null
                });
            } else {
                reject(new Error('Empty or invalid output from yt-dlp'));
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
}

function parseYtDlpProgress(line) {
    if (!line.startsWith('[download]')) return null;
    
    const content = line.substring(10).trim();
    
    if (content.startsWith('Destination:')) {
        return { isDestination: true };
    }
    
    // 1. Percentage and size
    const percentMatch = content.match(/~?\s*([\d.]+)%\s+of\s+~?\s*([\d.]+)(KiB|MiB|GiB|B)/i);
    const speedMatch = content.match(/at\s+~?\s*([\d.]+)(KiB|MiB|GiB|B)\/s/i);
    
    let downloadSpeed = 0;
    if (speedMatch) {
        let speedVal = parseFloat(speedMatch[1]);
        const speedUnit = speedMatch[2].toLowerCase();
        if (speedUnit === 'kib') speedVal *= 1024;
        else if (speedUnit === 'mib') speedVal *= 1024 * 1024;
        else if (speedUnit === 'gib') speedVal *= 1024 * 1024 * 1024;
        downloadSpeed = speedVal;
    }
    
    if (percentMatch) {
        const percent = parseFloat(percentMatch[1]);
        let totalVal = parseFloat(percentMatch[2]);
        const totalUnit = percentMatch[3].toLowerCase();
        
        let totalLength = totalVal;
        if (totalUnit === 'kib') totalLength *= 1024;
        else if (totalUnit === 'mib') totalLength *= 1024 * 1024;
        else if (totalUnit === 'gib') totalLength *= 1024 * 1024 * 1024;
        
        const completedLength = Math.round(totalLength * (percent / 100));
        return { completedLength, totalLength, downloadSpeed };
    }
    
    // 2. Unknown total size
    const unknownSizeMatch = content.match(/~?\s*([\d.]+)(KiB|MiB|GiB|B)\s+at/i);
    if (unknownSizeMatch) {
        let completedVal = parseFloat(unknownSizeMatch[1]);
        const completedUnit = unknownSizeMatch[2].toLowerCase();
        
        let completedLength = completedVal;
        if (completedUnit === 'kib') completedLength *= 1024;
        else if (completedUnit === 'mib') completedLength *= 1024 * 1024;
        else if (completedUnit === 'gib') completedLength *= 1024 * 1024 * 1024;
        
        return { completedLength, totalLength: completedLength, downloadSpeed };
    }
    
    return null;
}

module.exports = {
    findNodeRuntime,
    execYtDlpJson,
    resolveStreamUrls,
    parseYtDlpProgress
};

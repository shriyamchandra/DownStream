const { execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function activateApp(appName) {
    try {
        exec(`osascript -e 'tell application "${appName}" to activate'`, () => {});
    } catch (e) {}
}

function isUrlExpired(urlStr) {
    try {
        const parsed = new URL(urlStr);
        const expire = parsed.searchParams.get('expire');
        if (expire) {
            const expireTime = parseInt(expire) * 1000;
            return Date.now() > (expireTime - 60000);
        }
    } catch (e) {}
    return false;
}

function getIinaPath() {
    const paths = [
        '/Applications/IINA.app/Contents/MacOS/iina-cli',
        path.join(os.homedir(), 'Applications/IINA.app/Contents/MacOS/iina-cli')
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return 'iina-cli';
}

function getMpvPath() {
    const paths = [
        '/opt/homebrew/bin/mpv',
        '/usr/local/bin/mpv'
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return 'mpv';
}

function launchPlayer({ player, targetUrl, audioUrl = null, originalUrl = null, formatId = null, streamUrlCache = null, notifier = null, title = '' }) {
    let bin, args;

    // IINA/mpv can resolve split streams themselves via built-in yt-dlp
    const useYtdlWatchUrl = (player === 'iina' || player === 'mpv') && originalUrl && (audioUrl || !formatId || formatId === 'best');

    if (useYtdlWatchUrl) {
        if (player === 'iina') {
            bin = getIinaPath();
            args = [originalUrl, '--'];
            if (formatId && formatId !== 'best') {
                args.push(`--ytdl-format=${formatId}+bestaudio/best`);
            }
        } else { // mpv
            bin = getMpvPath();
            args = [originalUrl];
            if (formatId && formatId !== 'best') {
                args.push(`--ytdl-format=${formatId}+bestaudio/best`);
            }
        }
    } else {
        if (player === 'iina') {
            bin = getIinaPath();
            args = [targetUrl, '--', `--user-agent=${USER_AGENT}`];
        } else if (player === 'mpv') {
            bin = getMpvPath();
            args = [targetUrl, `--user-agent=${USER_AGENT}`];
        } else if (player === 'vlc') {
            bin = 'open';
            let playUrl = targetUrl;
            if (audioUrl && originalUrl) {
                const progCached = streamUrlCache ? streamUrlCache.get(`${originalUrl}|progressive`) : null;
                if (progCached && progCached.url) {
                    playUrl = progCached.url;
                    console.log('[VLC Fallback] Using progressive stream for VLC playback:', playUrl.substring(0, 60));
                }
            }
            if (audioUrl && playUrl === targetUrl) {
                args = ['-a', 'VLC', '--args', targetUrl, `:input-slave=${audioUrl}`, `--http-user-agent=${USER_AGENT}`];
            } else {
                args = ['-a', 'VLC', '--args', playUrl, `--http-user-agent=${USER_AGENT}`];
            }
        } else {
            bin = 'open';
            args = [targetUrl];
        }
    }

    console.log(`[Stream Launch] ${player}: ${bin}`, JSON.stringify(args.map(a => a.length > 80 ? a.substring(0, 77) + '...' : a)));
    execFile(bin, args, (err) => {
        if (err) console.error(`[Stream Launch] Failed to launch ${player}: ${err.message}`);
    });

    // Bring the player to the foreground
    const appName = player === 'iina' ? 'IINA' : player === 'mpv' ? 'mpv' : 'VLC';
    setTimeout(() => activateApp(appName), 500);

    if (notifier && title) {
        notifier.notify('DownStream', `Streaming in ${player.toUpperCase()}: ${title.substring(0, 45)}...`);
    }
}

module.exports = {
    USER_AGENT,
    isUrlExpired,
    launchPlayer
};

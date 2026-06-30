const path = require('path');
const fs = require('fs');
const os = require('os');

function isInPath(cmd) {
    try {
        const { execFileSync } = require('child_process');
        execFileSync('which', [cmd], { stdio: 'ignore' });
        return true;
    } catch (_) {
        return false;
    }
}

function isPlayerInstalled(player) {
    if (!player) return true;
    
    if (process.platform === 'darwin') {
        if (player === 'vlc') {
            return fs.existsSync('/Applications/VLC.app') || 
                   fs.existsSync(path.join(os.homedir(), 'Applications/VLC.app')) || 
                   isInPath('vlc');
        }
        if (player === 'iina') {
            return fs.existsSync('/Applications/IINA.app') || 
                   fs.existsSync(path.join(os.homedir(), 'Applications/IINA.app'));
        }
        if (player === 'mpv') {
            return isInPath('mpv') || 
                   fs.existsSync('/usr/local/bin/mpv') || 
                   fs.existsSync('/opt/homebrew/bin/mpv');
        }
    }
    return true;
}

module.exports = {
    isInPath,
    isPlayerInstalled
};

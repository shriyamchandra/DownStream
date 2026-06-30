const { execFile } = require('child_process');

function escapeAppleScript(str) {
    return String(str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// execFile + escaped strings — notification text must not reach a shell
module.exports = {
    notify(title, message) {
        const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;
        execFile('osascript', ['-e', script], () => {});
    }
};

const { execFile } = require('child_process');

// Escape a string for safe embedding inside an AppleScript string literal.
function escapeAppleScript(str) {
    return String(str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// macOS notifier. Uses execFile (argv array, no shell) so a title/message
// containing quotes, $(), or backticks can never break out into a shell command.
// Exposing a small { notify } interface keeps callers decoupled from the OS
// mechanism, so a Windows/Linux notifier can be swapped in later.
module.exports = {
    notify(title, message) {
        const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;
        execFile('osascript', ['-e', script], () => {});
    }
};

const toggle = document.getElementById('interceptToggle');
const label = document.getElementById('statusLabel');

// Load initial state
chrome.storage.local.get(['enabled'], (result) => {
    toggle.checked = result.enabled !== false;
    updateLabel(toggle.checked);
});

// Update state on toggle
toggle.addEventListener('change', () => {
    chrome.storage.local.set({ enabled: toggle.checked });
    updateLabel(toggle.checked);
});

function updateLabel(enabled) {
    label.innerText = enabled ? 'Interception Active' : 'Interception Disabled';
    label.style.color = enabled ? '#0a84ff' : '#969696';
}

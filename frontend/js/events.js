import { client } from './transport.js';
import { callApi } from './api.js';
import { state } from './state.js';
import { applyTheme } from './theme.js';
import { renderDownloads } from './render.js';
import { refreshDownloads } from './downloads.js';

// Wire up all DOM event listeners. Called once on startup (DOM is ready because
// the entry script is an ES module, which defers execution).
export function initEvents() {
    // Sidebar navigation (filters + settings view toggle).
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            state.currentFilter = item.getAttribute('data-filter');

            const downloadsView = document.getElementById('downloadsView');
            const settingsView = document.getElementById('settingsView');
            const toolbar = document.querySelector('.toolbar');

            if (state.currentFilter === 'settings') {
                if (downloadsView) downloadsView.classList.add('hidden');
                if (toolbar) toolbar.classList.add('hidden');
                if (settingsView) settingsView.classList.remove('hidden');
            } else {
                if (downloadsView) downloadsView.classList.remove('hidden');
                if (toolbar) toolbar.classList.remove('hidden');
                if (settingsView) settingsView.classList.add('hidden');
                renderDownloads();
            }
        });
    });

    // Save settings.
    document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
        const preferredPlayer = document.getElementById('prefPlayer').value;
        const downloadDir = document.getElementById('prefDir').value.trim();
        const preferredTheme = document.getElementById('prefTheme').value;
        try {
            const data = await callApi('/api/settings', { preferredPlayer, downloadDir });
            if (data.success) {
                state.appConfig = data.config;
                localStorage.setItem('appTheme', preferredTheme);
                applyTheme(preferredTheme);
                await client.call('changeGlobalOption', [{ dir: downloadDir }]);
                alert('Settings saved successfully!');
            }
        } catch (e) {
            alert('Failed to save settings.');
        }
    });

    // Add URL(s).
    document.getElementById('addBtn').addEventListener('click', async () => {
        const text = document.getElementById('urlInput').value.trim();
        const filename = document.getElementById('filenameInput').value.trim();
        const category = document.getElementById('categorySelect').value;
        if (!text) return;

        const urls = text.split(/[\n,]+/).map(u => u.trim()).filter(u => u);
        for (const url of urls) {
            const options = {};
            if (filename && urls.length === 1) options.out = filename;
            if (category && state.appConfig.downloadDir) {
                options.dir = `${state.appConfig.downloadDir}/${category}`;
            }
            await client.call('addUri', [[url], options]).catch(() => {});
        }

        document.getElementById('urlInput').value = '';
        document.getElementById('filenameInput').value = '';
        refreshDownloads();
    });

    // Drag-and-drop .torrent support.
    const dropZone = document.getElementById('dropZone');
    const dropOverlay = document.getElementById('dropOverlay');
    if (dropZone && dropOverlay) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropOverlay.classList.remove('hidden');
        });
        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            if (e.target === dropOverlay) dropOverlay.classList.add('hidden');
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropOverlay.classList.add('hidden');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                if (file.name.endsWith('.torrent')) {
                    const reader = new FileReader();
                    reader.onload = async (ev) => {
                        const base64Str = ev.target.result.split(',')[1];
                        await client.call('addTorrent', [base64Str]);
                        refreshDownloads();
                    };
                    reader.readAsDataURL(file);
                } else {
                    alert('Please drop a valid .torrent file.');
                }
            }
        });
    }

    // Toolbar: search, sort, clear history.
    document.getElementById('searchBar').addEventListener('input', renderDownloads);
    document.getElementById('sortSelect').addEventListener('change', renderDownloads);
    document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
        if (!confirm('Are you sure you want to clear all completed, failed, and stopped downloads from your history list? This will NOT delete any completed files on your disk.')) return;
        try {
            const res = await callApi('/api/history/clear-completed');
            if (res.success) refreshDownloads();
        } catch (e) {
            console.error('Failed to clear history', e);
        }
    });
}

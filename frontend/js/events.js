import { client } from './transport.js';
import { callApi } from './api.js';
import { state } from './state.js';
import { applyTheme } from './theme.js';
import { renderDownloads } from './render.js';
import { showToast } from './toast.js';
import {
    refreshDownloads, loadSettings,
    toggleExpand, pauseDl, resumeDl, deleteDownload, restartDl, streamFile, showInFinder, setGlobalSpeedLimit
} from './downloads.js';

export function initEvents() {
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

    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', async () => {
            if (saveSettingsBtn.disabled) return;
            saveSettingsBtn.disabled = true;

            const preferredPlayer = document.getElementById('prefPlayer').value;
            const downloadDir = document.getElementById('prefDir').value.trim();
            const youtubeCookiesBrowser = document.getElementById('prefCookiesBrowser').value;
            const preferredTheme = document.getElementById('prefTheme').value;
            try {
                const data = await callApi('/api/settings', { preferredPlayer, downloadDir, youtubeCookiesBrowser });
                if (data.success) {
                    state.appConfig = data.config;
                    localStorage.setItem('appTheme', preferredTheme);
                    applyTheme(preferredTheme);
                    await client.call('changeGlobalOption', [{ dir: downloadDir }]);
                    showToast('Settings Saved', 'Your configuration was successfully updated.', 'success');
                } else {
                    showToast('Error Saving Settings', data.error || 'Failed to save settings.', 'error');
                }
            } catch (e) {
                showToast('Error Saving Settings', e.message || 'Failed to save settings.', 'error');
            } finally {
                saveSettingsBtn.disabled = false;
            }
        });
    }

    const prefTheme = document.getElementById('prefTheme');
    if (prefTheme) {
        prefTheme.addEventListener('change', (e) => {
            applyTheme(e.target.value);
        });
    }

    const addBtn = document.getElementById('addBtn');
    if (addBtn) {
        addBtn.addEventListener('click', async () => {
            if (addBtn.disabled) return;
            addBtn.disabled = true;

            const text = document.getElementById('urlInput').value.trim();
            const filename = document.getElementById('filenameInput').value.trim();
            const category = document.getElementById('categorySelect').value;
            if (!text) {
                addBtn.disabled = false;
                return;
            }

            const urls = text.split(/[\n,]+/).map(u => u.trim()).filter(u => u);
            for (const url of urls) {
                const options = {};
                if (filename && urls.length === 1) options.out = filename;
                if (category && state.appConfig.downloadDir) {
                    options.dir = joinPaths(state.appConfig.downloadDir, category);
                }
                try {
                    await client.call('addUri', [[url], options]);
                } catch (err) {
                    console.error('Failed to add URI:', err);
                    showToast('Failed to Add Download', `Error adding URL ${url.substring(0, 30)}...: ${err.message || err}`, 'error');
                }
            }

            document.getElementById('urlInput').value = '';
            document.getElementById('filenameInput').value = '';
            refreshDownloads();
            addBtn.disabled = false;
        });
    }

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
                        try {
                            await client.call('addTorrent', [base64Str]);
                            refreshDownloads();
                        } catch (err) {
                            console.error('Failed to add Torrent:', err);
                            showToast('Failed to Add Torrent', err.message || err, 'error');
                        }
                    };
                    reader.readAsDataURL(file);
                } else {
                    showToast('Invalid File Type', 'Please drop a valid .torrent file.', 'error');
                }
            }
        });
    }

    document.getElementById('searchBar').addEventListener('input', renderDownloads);
    document.getElementById('sortSelect').addEventListener('change', renderDownloads);

    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    if (clearHistoryBtn) {
        clearHistoryBtn.addEventListener('click', async () => {
            if (clearHistoryBtn.disabled) return;
            if (!confirm('Are you sure you want to clear all completed, failed, and stopped downloads from your history list? This will NOT delete any completed files on your disk.')) return;

            clearHistoryBtn.disabled = true;
            try {
                const res = await callApi('/api/history/clear-completed');
                if (res.success) refreshDownloads();
            } catch (e) {
                console.error('Failed to clear history', e);
            } finally {
                clearHistoryBtn.disabled = false;
            }
        });
    }

    const speedLimitSelect = document.getElementById('speedLimitSelect');
    if (speedLimitSelect) {
        speedLimitSelect.addEventListener('change', async (e) => {
            if (speedLimitSelect.disabled) return;
            speedLimitSelect.disabled = true;
            try {
                await setGlobalSpeedLimit(e.target.value);
            } catch (err) {
                console.error('Failed to change speed limit:', err);
            } finally {
                speedLimitSelect.disabled = false;
            }
        });
    }

    const downloadsList = document.getElementById('downloadsList');
    if (downloadsList) {
        downloadsList.addEventListener('click', async (e) => {
            const targetAction = e.target.closest('[data-action]');
            if (!targetAction) return;

            const action = targetAction.getAttribute('data-action');
            const gid = targetAction.getAttribute('data-gid');
            if (!gid) return;

            if (action === 'toggle-expand') {
                toggleExpand(gid, e);
                return;
            }

            const isButton = targetAction.tagName === 'BUTTON';
            if (isButton) {
                if (targetAction.disabled) return;
                targetAction.disabled = true;
            }

            try {
                if (action === 'pause') {
                    await pauseDl(gid);
                } else if (action === 'resume') {
                    await resumeDl(gid);
                } else if (action === 'delete') {
                    const isHistorical = targetAction.getAttribute('data-historical') === 'true';
                    await deleteDownload(gid, isHistorical);
                } else if (action === 'restart') {
                    await restartDl(gid);
                } else if (action === 'show-in-finder') {
                    await showInFinder(gid);
                } else if (action === 'stream') {
                    await streamFile(gid);
                }
            } catch (err) {
                console.error(`Row action '${action}' failed:`, err);
            } finally {
                if (isButton) {
                    targetAction.disabled = false;
                }
            }
        });
    }
}

function joinPaths(...segments) {
    const sep = window.PATH_SEP || '/';
    return segments
        .map(s => String(s || '').trim())
        .filter(Boolean)
        .join(sep)
        .replace(new RegExp('\\' + sep + '+', 'g'), sep);
}

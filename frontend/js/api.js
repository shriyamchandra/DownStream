import { isTauri } from './env.js';
import { state } from './state.js';

// Universal API wrapper: Tauri IPC commands when embedded, HTTP fetch otherwise.
// (In Tauri mode only the endpoints below are bridged; history/intercept run
// over the embedded HTTP server, matching the original behavior.)
export async function callApi(endpoint, data = {}) {
    if (isTauri) {
        const core = window.__TAURI__.core;
        if (endpoint === '/api/settings') {
            if (Object.keys(data).length === 0) {
                return await core.invoke('load_settings');
            }
            await core.invoke('save_settings', { settings: data });
            return { success: true, config: data };
        } else if (endpoint === '/api/stream') {
            try {
                await core.invoke('stream_file', {
                    filename: data.filename,
                    filepath: data.filepath || null,
                    downloadDir: state.appConfig.downloadDir,
                    preferredPlayer: state.appConfig.preferredPlayer
                });
                return { success: true };
            } catch (err) {
                return { error: err };
            }
        } else if (endpoint === '/api/delete') {
            await core.invoke('delete_file', { filepath: data.filepath, downloadDir: state.appConfig.downloadDir });
            return { success: true };
        } else if (endpoint === '/api/showInFinder') {
            await core.invoke('show_in_finder', { filepath: data.filepath, downloadDir: state.appConfig.downloadDir });
            return { success: true };
        } else if (endpoint === '/api/notify') {
            await core.invoke('show_notification', { title: data.title, message: data.message });
            return { success: true };
        }
    } else {
        if (Object.keys(data).length === 0) {
            const res = await fetch(endpoint);
            return await res.json();
        }
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return await res.json();
    }
}

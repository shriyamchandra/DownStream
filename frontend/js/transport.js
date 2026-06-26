import { isTauri, _log } from './env.js';

// Talks to the aria2 engine. Two interchangeable transports sit behind one
// call() API — Tauri IPC (invoke) or a JSON-RPC WebSocket — so callers depend
// only on { call, onConnect, onMessage } and never on which one is in use.
class Aria2Client {
    constructor() {
        if (isTauri) {
            _log('Aria2Client: Using Tauri IPC bridge');
            // Defer so the caller can assign onConnect first.
            setTimeout(() => this._tryConnect(0), 50);
        } else {
            const ariaPort = (window.ARIA2_PORT || 6800);
            this.ws = new WebSocket(`ws://127.0.0.1:${ariaPort}/jsonrpc`);
            this.msgId = 0;
            this.callbacks = {};
            this.onMessage = null;

            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.id && this.callbacks[data.id]) {
                    const { resolve, reject } = this.callbacks[data.id];
                    delete this.callbacks[data.id];
                    // Reject on RPC errors so callers' .catch() works (otherwise an
                    // error object would be spread into an array and throw).
                    if (data.error) reject(data.error);
                    else resolve(data.result);
                } else if (data.method && this.onMessage) {
                    this.onMessage(data);
                }
            };

            this.ws.onopen = () => {
                _log('WebSocket connected to aria2c');
                if (this.onConnect) this.onConnect();
            };

            this.ws.onerror = () => {
                const list = document.getElementById('downloadsList');
                if (list) {
                    list.innerHTML = `<div class="empty-state" style="color: #ff453a">Could not connect to aria2c engine. Make sure the backend server is running.</div>`;
                }
            };

            this.ws.onclose = (e) => _log(`WebSocket closed: code=${e.code} reason=${e.reason}`);
        }
    }

    // Retry connecting to aria2c via Tauri IPC (it takes a moment to start).
    _tryConnect(attempt) {
        window.__TAURI__.core.invoke('aria2_rpc', { method: 'getVersion', params: [] })
            .then(() => { if (this.onConnect) this.onConnect(); })
            .catch((err) => {
                _log(`aria2_rpc attempt ${attempt} failed: ${err}`);
                if (attempt < 10) setTimeout(() => this._tryConnect(attempt + 1), 500);
            });
    }

    call(method, params = []) {
        if (isTauri) {
            return window.__TAURI__.core.invoke('aria2_rpc', { method, params });
        }
        return new Promise((resolve, reject) => {
            const id = ++this.msgId;
            this.callbacks[id] = { resolve, reject };
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    jsonrpc: '2.0',
                    id: id.toString(),
                    method: `aria2.${method}`,
                    params
                }));
            } else {
                setTimeout(() => this.call(method, params).then(resolve, reject), 500);
            }
        });
    }
}

// Single shared client instance.
export const client = new Aria2Client();

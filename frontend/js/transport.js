import { _log } from './env.js';

class Aria2Client {
    constructor() {
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

    call(method, params = []) {
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

export const client = new Aria2Client();

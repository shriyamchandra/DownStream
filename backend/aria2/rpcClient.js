const http = require('http');

module.exports = function createRpcClient({ host = 'localhost', port }) {
    function call(method, params) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify({
                jsonrpc: '2.0',
                id: 'backend',
                method: `aria2.${method}`,
                params
            });

            const req = http.request({
                hostname: host,
                port,
                path: '/jsonrpc',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`aria2 RPC HTTP status: ${res.statusCode}`));
                    res.resume();
                    return;
                }

                let data = '';
                res.on('data', chunk => {
                    data += chunk;
                    if (data.length > 5 * 1024 * 1024) { // 5MB safety limit
                        req.destroy();
                        reject(new Error('aria2 RPC response size exceeded 5MB safety limit'));
                    }
                });
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(e); }
                });
            });

            req.setTimeout(5000, () => {
                req.destroy();
                reject(new Error(`aria2 RPC timeout: ${method}`));
            });

            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }

    return { call };
};

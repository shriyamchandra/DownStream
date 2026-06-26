const http = require('http');

// Thin JSON-RPC client for the aria2 daemon. Resolves the full RPC response
// object ({ result } or { error }); callers branch on response.error. This is
// the single abstraction the download/sync logic depends on, so the transport
// can change without touching them.
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
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(e); }
                });
            });

            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }

    return { call };
};

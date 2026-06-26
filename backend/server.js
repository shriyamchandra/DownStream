const express = require('express');
const path = require('path');
const EventEmitter = require('events');

const createConfig = require('./config');
const createRpcClient = require('./aria2/rpcClient');
const createProcessManager = require('./aria2/processManager');
const createHistoryStore = require('./history/historyStore');
const createSyncService = require('./history/syncService');
const createPathGuard = require('./lib/pathGuard');
const notifier = require('./lib/notifier');
const { cors, requestLogger } = require('./middleware/httpGuards');

const settingsRoutes = require('./routes/settings');
const filesRoutes = require('./routes/files');
const historyRoutes = require('./routes/history');
const interceptRoutes = require('./routes/intercept');

// ── Composition root ──────────────────────────────────────────
// Build each single-responsibility piece and inject its collaborators. Nothing
// below reaches into another module's internals — they depend on the small
// { call } / { notify } / { isWithin } / { items, save } interfaces only.
const events = new EventEmitter();
const config = createConfig();
const pathGuard = createPathGuard(config);
const rpc = createRpcClient({ port: config.aria2Port });
const history = createHistoryStore(config);
const processManager = createProcessManager(config);
const sync = createSyncService({ rpc, history, config });

// Free ports + launch the aria2c engine before we start serving.
processManager.start();

const app = express();
app.use(express.json());
// Static assets are served before the origin guard so the UI loads normally;
// only the /api/* surface is gated by CORS.
app.use(express.static(path.join(config.projectRoot, 'frontend')));
app.use(cors);
app.use(requestLogger);

app.use(settingsRoutes({ config }));
app.use(filesRoutes({ config, pathGuard, notifier }));
app.use(historyRoutes({ rpc, history, config, pathGuard }));
app.use(interceptRoutes({ rpc, notifier, events }));

// Periodic aria2 <-> history reconciliation.
sync.start(2500);

app.listen(config.webPort, () => {
    console.log(`\n============================================`);
    console.log(`🚀 DownStream Web Manager is running!`);
    console.log(`👉 Open your browser to: http://localhost:${config.webPort}`);
    console.log(`============================================\n`);
});

// ── Shutdown ──────────────────────────────────────────────────
function cleanup() {
    processManager.cleanup();
}

process.on('SIGINT', () => { cleanup(); process.exit(); });
process.on('SIGTERM', () => { cleanup(); process.exit(); });

module.exports = { cleanup, events };

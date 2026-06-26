// HTTP middleware: origin guard + request logging.
//
// The server exposes file-deleting and app-launching endpoints, so it must NOT
// be reachable from arbitrary websites. Only the app's own frontend (localhost),
// the bundled Chrome extension, and non-browser local clients (which send no
// Origin header) are permitted.
const ALLOWED_ORIGIN_RE = /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|chrome-extension:\/\/[a-p]+)$/;

function originAllowed(origin) {
    return !origin || ALLOWED_ORIGIN_RE.test(origin);
}

function cors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(originAllowed(origin) ? 204 : 403);
    }
    // Block the request itself (not just the CORS response) so a cross-site page
    // can't trigger side effects like file deletion without reading the reply.
    if (!originAllowed(origin)) {
        return res.status(403).json({ error: 'Cross-origin request blocked.' });
    }
    next();
}

function requestLogger(req, res, next) {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    if (req.method === 'POST') console.log('Body:', JSON.stringify(req.body));
    next();
}

module.exports = { cors, requestLogger };

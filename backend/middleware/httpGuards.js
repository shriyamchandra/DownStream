const ALLOWED_EXTENSION_IDS = new Set([
    'egjdjkfddjpgakdgemjnfmdochggdelf',
    'hpbnhbgbllnkkdkhednecnkcpnkicmkp'
]);

function originAllowed(origin) {
    if (!origin) return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
    try {
        const url = new URL(origin);
        if (url.protocol === 'chrome-extension:') {
            return ALLOWED_EXTENSION_IDS.has(url.hostname);
        }
    } catch {}
    return false;
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
    if (!originAllowed(origin)) {
        return res.status(403).json({ error: 'Cross-origin request blocked.' });
    }
    next();
}

function requestLogger(req, res, next) {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    if (req.method === 'POST') {
        const sanitized = { ...req.body };
        if (sanitized.cookies) sanitized.cookies = '[REDACTED]';
        if (sanitized.url && sanitized.url.length > 80) {
            sanitized.url = sanitized.url.substring(0, 77) + '...';
        }
        console.log('Body:', JSON.stringify(sanitized));
    }
    next();
}

module.exports = { cors, requestLogger };

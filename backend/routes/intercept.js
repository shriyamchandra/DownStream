const express = require('express');
const { getFilenameFromUrl } = require('../shared-constants');

// Endpoint for the Chrome extension: queue an intercepted browser download into
// aria2, forwarding the browser's referrer / user-agent / cookies so authenticated
// (single-use-token) downloads keep working.
module.exports = function interceptRoutes({ rpc, notifier, events, handleIntercept }) {
    const router = express.Router();

    router.post('/api/intercept', async (req, res) => {
        try {
            // Prefer the shared handler (supports queuing for SOLID readiness handling)
            if (typeof handleIntercept === 'function') {
                const result = await handleIntercept(req.body);
                if (result.queued) {
                    return res.json({ success: true, queued: true });
                }
                return res.json(result);
            }

            // Fallback to direct implementation (for compatibility)
            const { url, filename, referrer, userAgent, cookies } = req.body;
            if (!url) return res.status(400).json({ error: 'URL is required' });

            const options = {};
            if (filename) options.out = filename;
            if (referrer) options.referer = referrer;
            if (userAgent) options['user-agent'] = userAgent;
            if (cookies) options.header = [`Cookie: ${cookies}`];

            const response = await rpc.call('addUri', [[url], options]);
            if (response.error) {
                return res.status(500).json({ error: response.error.message });
            }

            const cleanFilename = getFilenameFromUrl(url, filename || 'large_file');
            notifier.notify('DownStream', `Captured: ${cleanFilename.substring(0, 45)}... downloading at max speed!`);
            events.emit('intercept', { url, filename });

            res.json({ success: true, gid: response.result });
        } catch (e) {
            res.status(500).json({ error: 'Failed to communicate with aria2c engine.' });
        }
    });

    return router;
};

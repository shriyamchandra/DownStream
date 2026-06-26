const express = require('express');

// Endpoint for the Chrome extension: queue an intercepted browser download into
// aria2, forwarding the browser's referrer / user-agent / cookies so authenticated
// (single-use-token) downloads keep working.
module.exports = function interceptRoutes({ rpc, notifier, events }) {
    const router = express.Router();

    router.post('/api/intercept', async (req, res) => {
        const { url, filename, referrer, userAgent, cookies } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        const options = {};
        if (filename) options.out = filename;
        if (referrer) options.referer = referrer;
        if (userAgent) options['user-agent'] = userAgent;
        if (cookies) options.header = [`Cookie: ${cookies}`];

        try {
            const response = await rpc.call('addUri', [[url], options]);
            if (response.error) {
                return res.status(500).json({ error: response.error.message });
            }

            // Native notification for user feedback.
            const rawFilename = filename || url.split('/').pop().split('?')[0] || 'large_file';
            let cleanFilename = rawFilename;
            try { cleanFilename = decodeURIComponent(rawFilename); } catch (e) {}
            notifier.notify('DownStream', `Captured: ${cleanFilename.substring(0, 45)}... downloading at max speed!`);

            // Let the Electron shell restore/focus its window.
            events.emit('intercept', { url, filename });

            res.json({ success: true, gid: response.result });
        } catch (e) {
            res.status(500).json({ error: 'Failed to communicate with aria2c engine.' });
        }
    });

    return router;
};

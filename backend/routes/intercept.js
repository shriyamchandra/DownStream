const express = require('express');

module.exports = function interceptRoutes({ handleIntercept }) {
    const router = express.Router();

    router.post('/api/intercept', async (req, res) => {
        try {
            if (typeof handleIntercept !== 'function') {
                return res.status(500).json({ error: 'Aria2c intercept engine is not initialized.' });
            }

            const result = await handleIntercept(req.body || {});
            if (result.queued) {
                return res.json({ success: true, queued: true });
            }
            return res.json(result);
        } catch (e) {
            console.error('[Intercept Error]', e);
            const isValErr = e.message.includes('required') || e.message.includes('Invalid') || e.message.includes('safe');
            const status = isValErr ? 400 : 500;
            res.status(status).json({ error: e.message || 'Failed to process intercept request.' });
        }
    });

    return router;
};

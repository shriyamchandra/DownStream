const express = require('express');

module.exports = function settingsRoutes({ config, rpc }) {
    const router = express.Router();

    router.get('/api/settings', (req, res) => {
        res.json(config.data);
    });

    router.post('/api/settings', async (req, res) => {
        try {
            const updated = config.update(req.body || {});
            res.json({ success: true, config: updated });

            // Apply bandwidth limit to aria2 in real-time if changed
            if (req.body.maxDownloadSpeed !== undefined && rpc) {
                const speed = parseInt(req.body.maxDownloadSpeed, 10) || 0;
                const limit = speed > 0 ? `${speed}K` : '0';
                try {
                    await rpc.call('changeGlobalOption', [{ 'max-overall-download-limit': limit }]);
                    console.log(`[Settings] Updated aria2 bandwidth limit to ${limit}`);
                } catch (e) {
                    console.error('[Settings] Failed to update aria2 bandwidth limit:', e.message);
                }
            }
        } catch (error) {
            console.error('Failed to update settings:', error);
            const isValidationError = error.message.includes('Invalid') || 
                                      error.message.includes('not installed') || 
                                      error.message.includes('Failed to create');
            if (isValidationError) {
                res.status(400).json({ success: false, error: error.message });
            } else {
                res.status(500).json({ success: false, error: 'Internal error updating settings.' });
            }
        }
    });

    return router;
};

const express = require('express');

module.exports = function settingsRoutes({ config }) {
    const router = express.Router();

    router.get('/api/settings', (req, res) => {
        res.json(config.data);
    });

    router.post('/api/settings', (req, res) => {
        try {
            const updated = config.update(req.body || {});
            res.json({ success: true, config: updated });
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

const express = require('express');

// Settings endpoints: read and update the persisted config.
module.exports = function settingsRoutes({ config }) {
    const router = express.Router();

    router.get('/api/settings', (req, res) => {
        res.json(config.data);
    });

    router.post('/api/settings', (req, res) => {
        const updated = config.update(req.body || {});
        res.json({ success: true, config: updated });
    });

    return router;
};

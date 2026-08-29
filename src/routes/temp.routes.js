const express = require('express');
const router = express.Router();

// Disabled temporary route: removed after SUPER creation.
router.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));

module.exports = router;

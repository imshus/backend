const express = require('express');
const router = express.Router();
const historyController = require('../controllers/history.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');

// Settings -> History, for the owner and every employee alike: each sees
// only what their own session may (the shop's for the owner).
router.use(authenticateJWT);

// GET /api/v1/history/scans?limit=30 – priced scans, newest first
router.get('/scans', historyController.getScanHistory);

module.exports = router;

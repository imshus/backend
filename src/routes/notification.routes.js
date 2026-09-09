const express = require('express');
const notificationController = require('../controllers/notification.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authenticateJWT);
router.get('/', notificationController.getNotifications);

module.exports = router;

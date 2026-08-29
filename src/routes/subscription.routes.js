const express = require('express');
const router = express.Router();

const subscriptionController = require('../controllers/subscription.controller');
const { authenticateJWT, requireRole } = require('../middleware/auth.middleware');
const { attachLicenseContext } = require('../middleware/license.middleware');

router.use(authenticateJWT);
router.use(attachLicenseContext);

router.get('/overview', requireRole('OWNER', 'ADMIN'), subscriptionController.getOverview);
router.get('/scan-billing', requireRole('OWNER', 'ADMIN'), subscriptionController.getScanBillingHistory);
router.get('/credit-transactions', requireRole('OWNER', 'ADMIN'), subscriptionController.getCreditTransactionHistory);

router.post('/trial/start', requireRole('OWNER', 'ADMIN'), subscriptionController.startTrial);
router.post('/purchase', requireRole('OWNER', 'ADMIN'), subscriptionController.purchaseApplication);

router.post('/credits/add', requireRole('SUPER'), subscriptionController.addCredits);
router.post('/credits/remove', requireRole('SUPER'), subscriptionController.removeCredits);
router.post('/credits/set', requireRole('SUPER'), subscriptionController.setCredits);
router.post('/credits/reset', requireRole('SUPER'), subscriptionController.resetCredits);

module.exports = router;

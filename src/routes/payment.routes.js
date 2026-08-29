const express = require('express');

const paymentController = require('../controllers/payment.controller');
const { authenticateJWT, requireRole } = require('../middleware/auth.middleware');
const {
	attachLicenseContext,
	requireLicense,
} = require('../middleware/license.middleware');

const router = express.Router();

router.use(authenticateJWT);
router.use(attachLicenseContext);

router.post('/orders/application', requireRole('OWNER', 'ADMIN'), paymentController.createApplicationOrder);
router.post('/orders/credits', requireRole('OWNER', 'ADMIN'), requireLicense, paymentController.createCreditOrder);
router.post('/verify', requireRole('OWNER', 'ADMIN'), paymentController.verifyPayment);
router.post('/mark-failure', requireRole('OWNER', 'ADMIN'), paymentController.markPaymentFailure);
router.get('/history', requireRole('OWNER', 'ADMIN'), paymentController.getPaymentHistory);

module.exports = router;

const express = require('express');

const paymentController = require('../controllers/payment.controller');
const { authenticateJWT, requireRole } = require('../middleware/auth.middleware');
const { attachLicenseContext } = require('../middleware/license.middleware');

const router = express.Router();

router.use(authenticateJWT);
router.use(attachLicenseContext);

router.post('/orders/application', requireRole('OWNER', 'ADMIN'), paymentController.createApplicationOrder);
// No licence required to buy credits. It used to demand a permanent one, so
// a shop on its trial — exactly the shop most likely to run low — was refused
// at the point of paying us.
router.post('/orders/credits', requireRole('OWNER', 'ADMIN'), paymentController.createCreditOrder);
router.post('/verify', requireRole('OWNER', 'ADMIN'), paymentController.verifyPayment);
router.post('/mark-failure', requireRole('OWNER', 'ADMIN'), paymentController.markPaymentFailure);
router.get('/history', requireRole('OWNER', 'ADMIN'), paymentController.getPaymentHistory);

module.exports = router;

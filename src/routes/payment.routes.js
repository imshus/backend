const express = require('express');

const paymentController = require('../controllers/payment.controller');
const { authenticateJWT, requireRole } = require('../middleware/auth.middleware');
const { attachLicenseContext } = require('../middleware/license.middleware');
const { perUserLimiter } = require('../middleware/rateLimiter');

// Each send goes out over the SMTP account; twenty an hour is far beyond a
// shop asking for its own invoices again.
const paymentInvoiceEmailLimiter = perUserLimiter({
  name: 'payment_invoice_email',
  limit: 20,
  windowSeconds: 3600,
  message: 'Too many invoice emails this hour. Please try again later.',
});

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
// MRPscan's invoice for one of the shop's own paid orders: shown in the app
// after a payment, and emailed on request.
router.get('/:orderId/invoice', requireRole('OWNER', 'ADMIN'), paymentController.getPaymentInvoice);
router.post('/:orderId/invoice/email', requireRole('OWNER', 'ADMIN'), paymentInvoiceEmailLimiter, paymentController.emailPaymentInvoice);

module.exports = router;

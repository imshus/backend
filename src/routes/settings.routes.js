const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settings.controller');
const customChargeController = require('../controllers/customCharge.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');
const { requireRole } = require('../middleware/auth.middleware');
const { gstRateLimiter, otpSendLimiter, profileEditLimiter } = require('../middleware/rateLimiter');

router.use(authenticateJWT);

// Business identity straight from the database, for the Profile screen.
router.get('/business-profile', settingsController.getBusinessProfile);

// Changing the phone number or the GSTIN: the MPIN again, then an OTP to the
// new number and a registry lookup for the new GSTIN. The owner's alone — an
// employee moving the account's phone number would be moving the licence.
router.post('/business-profile/verify-mpin', requireRole('OWNER'), profileEditLimiter, settingsController.startProfileEdit);
router.post('/business-profile/phone-otp', requireRole('OWNER'), otpSendLimiter, settingsController.sendProfilePhoneOtp);
router.post('/business-profile/gst-preview', requireRole('OWNER'), gstRateLimiter, settingsController.previewProfileGst);
router.post('/business-profile', requireRole('OWNER'), settingsController.updateBusinessProfile);

// Per-business e-invoicing (IRP) credentials; the owner's to manage.
router.get('/einvoice', requireRole('OWNER', 'ADMIN'), settingsController.getEInvoiceSettings);
router.post('/einvoice', requireRole('OWNER', 'ADMIN'), settingsController.updateEInvoiceSettings);

router.get('/formula', settingsController.getFormulaConfig);
router.post('/formula', requirePermission('manageFormulae'), settingsController.updateFormulaConfig);

// Which bullion house the Home rate follows, plus the houses a shop added.
router.get('/bullion', settingsController.getBullionSources);
router.post('/bullion', requirePermission('homeDashboardMetricsControls'), settingsController.updateBullionSources);

router.get('/matrices', settingsController.getDashboardMatrices);
router.post('/matrices', requirePermission('homeDashboardMetricsControls'), settingsController.updateDashboardMatrices);

// Supreme rates - only SUPER role can access
router.get('/supreme-rates', requireRole('SUPER'), settingsController.getSupremeRates);
router.put('/supreme-rates', requireRole('SUPER'), settingsController.updateSupremeRates);

// Custom charge names
router.get('/charge-names', customChargeController.getChargeNames);
router.post('/charge-names', customChargeController.createCustomCharge);
router.delete('/charge-names/:id', customChargeController.deleteCustomCharge);

module.exports = router;

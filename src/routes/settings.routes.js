const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settings.controller');
const customChargeController = require('../controllers/customCharge.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');
const { requireRole } = require('../middleware/auth.middleware');

router.use(authenticateJWT);

router.get('/formula', settingsController.getFormulaConfig);
router.post('/formula', requirePermission('manageFormulae'), settingsController.updateFormulaConfig);

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

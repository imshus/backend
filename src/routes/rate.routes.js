const express = require('express');
const router = express.Router();
const rateController = require('../controllers/rate.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticateJWT);

// GET requests are open to all authenticated users (Employees + Owners)
// Gold
router.get('/gold', rateController.getGoldRates);
router.post('/gold', requirePermission('editRateGold'), rateController.updateGoldRate);
router.patch('/gold/visibility', requirePermission('editRateGold'), rateController.updateGoldRateVisibility);

router.get('/gold/tax-settings', rateController.getGoldTaxSettings);
router.post('/gold/tax-settings', requirePermission('editRateGold'), rateController.updateGoldTaxSettings);

// Diamond
router.get('/diamond', rateController.getDiamondRates);
router.post('/diamond/lookup', rateController.lookupDiamondRate);
router.post('/diamond', requirePermission('editRateDiamond'), rateController.addOrUpdateDiamondRate);
router.delete('/diamond/:id', requirePermission('editRateDiamond'), rateController.deleteDiamondRate);

// Colourstone
router.get('/colorstone', rateController.getColorstoneRates);
router.post('/colorstone', requirePermission('editRateColorstone'), rateController.addOrUpdateColorstoneRate);
router.delete('/colorstone/:id', requirePermission('editRateColorstone'), rateController.deleteColorstoneRate);

// Labour
router.get('/labour', rateController.getLabourRate);
router.post('/labour', requirePermission('editRateLabour'), rateController.upsertLabourRate);

module.exports = router;

const express = require('express');
const labourCodeController = require('../controllers/labourCode.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authenticateJWT);

// Each user keeps their own list, as with the wastage and item codes: an
// employee starts on the shop's codes and their first change gives them a
// private copy.
router.get('/', labourCodeController.listLabourCodes);
router.post('/', labourCodeController.saveLabourCode);
router.delete('/:id', labourCodeController.deleteLabourCode);

module.exports = router;

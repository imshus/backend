const express = require('express');
const wastageCodeController = require('../controllers/wastageCode.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authenticateJWT);

// Each user keeps their own list, as with the item codes: an employee starts
// on the shop's codes and their first change gives them a private copy.
router.get('/', wastageCodeController.listWastageCodes);
router.post('/', wastageCodeController.saveWastageCode);
router.delete('/:id', wastageCodeController.deleteWastageCode);

module.exports = router;

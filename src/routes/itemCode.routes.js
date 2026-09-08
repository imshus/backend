const express = require('express');
const itemCodeController = require('../controllers/itemCode.controller');
const { authenticateJWT, requireRole } = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authenticateJWT);

// Any signed-in member of the shop can read the catalogue; only the owner
// shapes it.
router.get('/', itemCodeController.listItemCodes);
router.post('/', requireRole('OWNER', 'ADMIN'), itemCodeController.saveItemCode);
router.delete('/:id', requireRole('OWNER', 'ADMIN'), itemCodeController.deleteItemCode);

module.exports = router;

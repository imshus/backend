const express = require('express');
const itemCodeController = require('../controllers/itemCode.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authenticateJWT);

// Each user keeps their own list: an employee starts on the shop's codes and
// their first change gives them a private copy, so writing is open to anyone
// signed in — the owner's writes are the shop's.
router.get('/', itemCodeController.listItemCodes);
router.post('/', itemCodeController.saveItemCode);
router.delete('/:id', itemCodeController.deleteItemCode);

module.exports = router;

const express = require('express');
const router = express.Router();
const historyController = require('../controllers/history.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');

// Settings -> History, for the owner and every employee alike: each sees
// only what their own session may (the shop's for the owner).
router.use(authenticateJWT);

// GET /api/v1/history/scans?limit=30&before=<cursor> – scans from the moment they are read, newest first
router.get('/scans', historyController.getScanHistory);
// GET /api/v1/history/scans/:scanId – one scan: everything read, and the latest price's workings
router.get('/scans/:scanId', historyController.getScanHistoryItem);

// GET /api/v1/history/wishlist?limit=30&before=<cursor> – every piece added to a wishlist
router.get('/wishlist', historyController.getWishlistHistory);
// GET /api/v1/history/wishlist/:id – one, with the wishlist item's snapshot
router.get('/wishlist/:id', historyController.getWishlistHistoryItem);

// GET /api/v1/history/checkouts?limit=30&before=<cursor> – invoices as the carts they billed
router.get('/checkouts', historyController.getCheckoutHistory);
// GET /api/v1/history/checkouts/:id – one, for the cart page
router.get('/checkouts/:id', historyController.getCheckoutHistoryItem);

module.exports = router;

const express = require('express');
const router = express.Router();
const wishlistController = require('../controllers/wishlist.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');

// All wishlist routes require a valid JWT
router.use(authenticateJWT);

// POST   /api/v1/wishlist          – add item
router.post('/', wishlistController.addToWishlist);

// GET    /api/v1/wishlist          – fetch all items for business
router.get('/', wishlistController.getWishlist);

// DELETE /api/v1/wishlist/:itemId  – delete a single item
router.delete('/:itemId', wishlistController.deleteWishlistItem);

// DELETE /api/v1/wishlist          – clear entire wishlist
router.delete('/', wishlistController.clearWishlist);

module.exports = router;

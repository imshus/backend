const Wishlist = require('../models/wishlist.model');
const { sendSuccess } = require('../utils/apiResponse');

/**
 * POST /api/v1/wishlist
 * Saves a new wishlist item to MongoDB.
 * Body: { itemId, title, tagCode, totalMrp, priceBadge, calculationRate, scanTimestamp, snapshot }
 */
const addToWishlist = async (req, res, next) => {
  try {
    const businessId = req.user?.businessId || req.user?._id;
    const userId = req.user?.userId;
    if (!businessId || !userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized – missing business or user context' });
    }

    const { itemId, title, tagCode, totalMrp, priceBadge, calculationRate, scanTimestamp, snapshot } = req.body;

    if (!itemId || !title || !tagCode || !scanTimestamp || !snapshot) {
      return res.status(400).json({
        success: false,
        message: 'itemId, title, tagCode, scanTimestamp and snapshot are required',
      });
    }

    // Upsert by itemId + businessId + userId so duplicate taps are idempotent per user
    const item = await Wishlist.findOneAndUpdate(
      { itemId, businessId, userId },
      {
        $setOnInsert: {
          businessId,
          userId,
          itemId,
          title,
          tagCode,
          totalMrp: totalMrp ?? 0,
          priceBadge: priceBadge ?? '',
          scanTimestamp,
          snapshot,
          ...(calculationRate === 'rtgs' || calculationRate === 'cash'
            ? { calculationRate }
            : {}),
        },
      },
      { upsert: true, new: true, runValidators: true }
    );

    sendSuccess(res, { item });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/wishlist
 * Returns all wishlist items for the authenticated business, newest first.
 */
const getWishlist = async (req, res, next) => {
  try {
    const businessId = req.user?.businessId || req.user?._id;
    const userId = req.user?.userId;
    if (!businessId || !userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const items = await Wishlist.find({ businessId, userId }).sort({ createdAt: -1 }).lean();
    console.log('Fetching wishlist for businessId:', businessId, 'userId:', userId, 'Found:', items.length);

    sendSuccess(res, { items });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/v1/wishlist/:itemId
 * Deletes a single wishlist item by its client-generated itemId.
 */
const deleteWishlistItem = async (req, res, next) => {
  try {
    const businessId = req.user?.businessId || req.user?._id;
    const userId = req.user?.userId;
    const { itemId } = req.params;

    const result = await Wishlist.deleteOne({ itemId, businessId, userId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Wishlist item not found' });
    }

    sendSuccess(res, { itemId });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/v1/wishlist
 * Clears the entire wishlist for the authenticated business.
 */
const clearWishlist = async (req, res, next) => {
  try {
    const businessId = req.user?.businessId || req.user?._id;
    const userId = req.user?.userId;
    if (!businessId || !userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    await Wishlist.deleteMany({ businessId, userId });

    sendSuccess(res, {});
  } catch (err) {
    next(err);
  }
};

module.exports = {
  addToWishlist,
  getWishlist,
  deleteWishlistItem,
  clearWishlist,
};

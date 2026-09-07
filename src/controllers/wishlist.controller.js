const Wishlist = require('../models/wishlist.model');
const Employee = require('../models/employee.model');
const { sendSuccess } = require('../utils/apiResponse');
const { isOwnerRole } = require('../services/userScope.service');

/**
 * Whose items a request may see and touch. An employee's wishlist is their
 * own; the owner's is the whole shop's, every employee's items included.
 */
const visibleItemsFilter = (user) => {
  const businessId = user?.businessId || user?._id;
  const userId = user?.userId;
  if (!businessId || !userId) return null;
  return isOwnerRole(user?.role) ? { businessId } : { businessId, userId };
};

/**
 * The name of whoever saved each item, for a list that shows more than one
 * person's items. The requester's own items carry no name.
 */
const attachSavedBy = async (items, user) => {
  const ownId = String(user?.userId || '');
  const otherIds = [...new Set(items.map((item) => String(item.userId || '')).filter((id) => id && id !== ownId))];
  if (otherIds.length === 0) return items.map((item) => ({ ...item, savedBy: null }));
  const employees = await Employee.find({ _id: { $in: otherIds } }).select('name').lean();
  const names = new Map(employees.map((employee) => [String(employee._id), employee.name || 'Staff']));
  return items.map((item) => {
    const id = String(item.userId || '');
    return { ...item, savedBy: id && id !== ownId ? names.get(id) || 'Staff' : null };
  });
};

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

    sendSuccess(res, { item: { ...item.toObject(), savedBy: null } });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/wishlist
 * The requester's own items, newest first — or, for the owner, everyone's.
 */
const getWishlist = async (req, res, next) => {
  try {
    const filter = visibleItemsFilter(req.user);
    if (!filter) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const items = await Wishlist.find(filter).sort({ createdAt: -1 }).lean();
    console.log('Fetching wishlist', { ...filter, owner: isOwnerRole(req.user?.role), found: items.length });

    sendSuccess(res, { items: await attachSavedBy(items, req.user) });
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
    const filter = visibleItemsFilter(req.user);
    if (!filter) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const { itemId } = req.params;

    const result = await Wishlist.deleteOne({ ...filter, itemId });

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
 * Clears everything the requester can see: their own list, or the shop's
 * whole list for the owner.
 */
const clearWishlist = async (req, res, next) => {
  try {
    const filter = visibleItemsFilter(req.user);
    if (!filter) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    await Wishlist.deleteMany(filter);

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

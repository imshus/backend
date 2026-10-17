const mongoose = require('mongoose');
const { sendSuccess } = require('../utils/apiResponse');
const scanHistory = require('../services/scanHistory.service');
const wishlistHistory = require('../services/wishlistHistory.service');
const checkoutHistory = require('../services/checkoutHistory.service');
const { InvalidCursorError } = require('../services/historyPage');

/**
 * Settings -> History: Tag scan history, Wishlist history and Checkout
 * history, each a list (newest first, paged by ?limit=30&before=<cursor>)
 * and a page per line. The owner sees the shop's, an employee their own (the
 * rule GET /invoices keeps); a line the session may not see is a 404, as one
 * that does not exist.
 */

const unauthorized = (res) =>
  res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });

const notFound = (res, message) =>
  res.status(404).json({ success: false, error: 'NOT_FOUND', message });

const hasShop = (req) => mongoose.isValidObjectId(String(req.user?.businessId || ''));

/**
 * A list handler: `list(user, { limit, before })` answers
 * { items, nextCursor }. A cursor this server did not hand out is a 400.
 */
const listHandler = (list) => async (req, res, next) => {
  try {
    if (!hasShop(req)) return unauthorized(res);
    const page = await list(req.user, { limit: req.query?.limit, before: req.query?.before });
    sendSuccess(res, page);
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      return res.status(400).json({ success: false, error: err.code, message: err.message });
    }
    next(err);
  }
};

/** A one-line handler: `get(user, id)` answers the line, or null for a 404. */
const itemHandler = (get, param, missing) => async (req, res, next) => {
  try {
    if (!hasShop(req)) return unauthorized(res);
    const item = await get(req.user, req.params[param]);
    if (!item) return notFound(res, missing);
    sendSuccess(res, { item });
  } catch (err) {
    next(err);
  }
};

// GET /history/scans: { items: [{ id, scanId, itemName, tagCode, finalMRP, status, createdAt }], nextCursor }
const getScanHistory = listHandler(scanHistory.listScans);
// GET /history/scans/:scanId: { item: { scanId, itemName, tagCode, finalMRP, status, createdAt, updatedAt, details, pricing } }
const getScanHistoryItem = itemHandler(scanHistory.getScan, 'scanId', 'Scan not found in history');

// GET /history/wishlist: { items: [{ id, itemName, tagCode, mrp, createdAt }], nextCursor }
const getWishlistHistory = listHandler(wishlistHistory.listWishlist);
// GET /history/wishlist/:id: { item: { id, ..., snapshot } }
const getWishlistHistoryItem = itemHandler(wishlistHistory.getWishlistEntry, 'id', 'Wishlist entry not found in history');

// GET /history/checkouts: { items: [{ id, invoiceNumber, pieceCount, pieces, grandTotal, createdAt }], nextCursor }
const getCheckoutHistory = listHandler(checkoutHistory.listCheckouts);
// GET /history/checkouts/:id: { item: { ..., customerName } }
const getCheckoutHistoryItem = itemHandler(checkoutHistory.getCheckout, 'id', 'Checkout not found in history');

module.exports = {
  getScanHistory,
  getScanHistoryItem,
  getWishlistHistory,
  getWishlistHistoryItem,
  getCheckoutHistory,
  getCheckoutHistoryItem,
};

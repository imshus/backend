const mongoose = require('mongoose');
const WishlistHistory = require('../models/wishlistHistory.model');
const { ownWorkFilter } = require('./userScope.service');
const { normalizeKarat, karatFromFineness } = require('./pricingInputs');
const { typeNameOf } = require('./scanHistory.service');
const { pageQuery, readPage } = require('./historyPage');

/**
 * Settings -> History -> Wishlist history: every piece ever added to a
 * wishlist, newest first, kept after the wishlist item itself is removed.
 */

const MAX_TEXT = 200;

/** A short optional text from the request: trimmed, '' when absent or not text. */
const shortText = (value) =>
  (typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, MAX_TEXT) : '');

/**
 * The name a wishlist line carries, first that applies: the name the app
 * sent with the item, the Masters item name on the card it was saved from
 * (snapshot.scanData.itemName), else the karat and type as a scan line names
 * them ("22K Gold", "18K Diamond Jewellery").
 */
function wishlistItemNameOf(item, sentName) {
  const named = shortText(sentName) || shortText(item?.snapshot?.scanData?.itemName);
  if (named) return named;
  const scanData = item?.snapshot?.scanData || {};
  const karat = normalizeKarat(scanData.karat) || karatFromFineness(scanData.tunch) || normalizeKarat(scanData.tunch);
  const type = item?.snapshot?.selectedType || item?.title;
  return [karat, typeNameOf(type)].filter(Boolean).join(' ');
}

/** The scan a wishlist item was priced from, when the app said: sent with it, else in its snapshot. */
const wishlistScanIdOf = (item, sentScanId) =>
  shortText(sentScanId) || shortText(item?.snapshot?.scanId) || shortText(item?.snapshot?.scanData?.scanId);

/**
 * Records a wishlist item just added (`item`, the saved Wishlist record) as a
 * line of its own, copied whole: removing or clearing the wishlist later
 * leaves it be. One line per item, so the add's idempotent repeat taps write
 * nothing more. `itemName` and `scanId` are what the request said, if
 * anything. Without a database connection nothing is written. Returns
 * whether a new line was written.
 */
async function recordWishlistAdd({ item, itemName, scanId } = {}) {
  if (mongoose.connection.readyState !== 1) return false;
  const businessId = String(item?.businessId || '');
  const userId = String(item?.userId || '').trim();
  const wishlistItemId = String(item?.itemId || '').trim();
  if (!mongoose.isValidObjectId(businessId) || !userId || !wishlistItemId) return false;

  const key = { businessId, userId, wishlistItemId };
  const mrp = Number(item.totalMrp);
  try {
    const result = await WishlistHistory.updateOne(
      key,
      {
        $setOnInsert: {
          scanId: wishlistScanIdOf(item, scanId),
          itemName: wishlistItemNameOf(item, itemName),
          tagCode: String(item.tagCode || ''),
          mrp: Number.isFinite(mrp) ? mrp : 0,
          title: String(item.title || ''),
          priceBadge: String(item.priceBadge || ''),
          calculationRate: String(item.calculationRate || ''),
          scanTimestamp: String(item.scanTimestamp || ''),
          snapshot: item.snapshot ?? null,
        },
      },
      { upsert: true },
    );
    return result.upsertedCount > 0;
  } catch (error) {
    // Two taps at once: the other one wrote the line.
    if (error?.code === 11000) return false;
    throw error;
  }
}

/** Whose lines a session sees: the shop's for an owner, its own for an employee. */
const visibleFilter = (user) => ({ businessId: user.businessId, ...ownWorkFilter(user) });

/** The query behind listWishlist; its filter and order are the model's compound indexes'. */
function wishlistQuery(user, { limit, before } = {}) {
  return pageQuery(WishlistHistory, visibleFilter(user), { limit, before })
    .select('itemName tagCode mrp createdAt');
}

/**
 * A page of a session's wishlist history, newest first:
 * { items: [{ id, itemName, tagCode, mrp, createdAt }], nextCursor }.
 */
async function listWishlist(user, { limit, before } = {}) {
  const { lines, nextCursor } = await readPage(wishlistQuery(user, { limit, before }), { limit });
  return {
    items: lines.map((line) => ({
      id: String(line._id),
      itemName: line.itemName,
      tagCode: line.tagCode,
      mrp: line.mrp,
      createdAt: line.createdAt,
    })),
    nextCursor,
  };
}

/** One wishlist line whole, snapshot included; null when the session may not see it (or there is none). */
async function getWishlistEntry(user, id) {
  if (!mongoose.isValidObjectId(String(id || ''))) return null;
  const line = await WishlistHistory.findOne({ _id: id, ...visibleFilter(user) }).lean();
  if (!line) return null;
  return {
    id: String(line._id),
    wishlistItemId: line.wishlistItemId,
    scanId: line.scanId || null,
    itemName: line.itemName,
    tagCode: line.tagCode,
    mrp: line.mrp,
    title: line.title,
    priceBadge: line.priceBadge,
    calculationRate: line.calculationRate || null,
    scanTimestamp: line.scanTimestamp || null,
    createdAt: line.createdAt,
    snapshot: line.snapshot ?? null,
  };
}

module.exports = {
  wishlistItemNameOf,
  recordWishlistAdd,
  wishlistQuery,
  listWishlist,
  getWishlistEntry,
};

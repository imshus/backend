const mongoose = require('mongoose');

// Kept for six months, as the tag scan history is, then dropped by MongoDB
// itself (the TTL index below).
const WISHLIST_HISTORY_TTL_SECONDS = 180 * 24 * 60 * 60;

/**
 * One piece added to a wishlist, for Settings -> History -> Wishlist history.
 *
 * Written by POST /wishlist when it adds an item, and never touched again:
 * removing the item, or clearing the wishlist, leaves its history behind, so
 * the shop can still see what was shortlisted and at what price.
 */
const wishlistHistorySchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
    },
    // The account that added it, as the wishlist item carries it: the
    // owner's business_users id, or the Employee document's.
    userId: {
      type: String,
      required: true,
    },
    // The wishlist item's own id (the app's itemId, which a cart sends back
    // as wishlist_item_id).
    wishlistItemId: {
      type: String,
      required: true,
    },
    // The scan it was priced from, when the app said which; '' otherwise.
    scanId: {
      type: String,
      default: '',
    },
    // The Masters item's name when the card had one, else "<karat> <type>".
    itemName: {
      type: String,
      default: '',
      trim: true,
    },
    tagCode: {
      type: String,
      default: '',
      trim: true,
    },
    // The MRP to the rupee when it was added.
    mrp: {
      type: Number,
      default: 0,
    },
    // The rest of the wishlist item as it was added: its title, price badge,
    // rate mode, scan time, and its snapshot (the reading and the pricing
    // the card held).
    title: { type: String, default: '' },
    priceBadge: { type: String, default: '' },
    calculationRate: { type: String, default: '' },
    scanTimestamp: { type: String, default: '' },
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'wishlist_history',
  },
);

// One line per wishlist item, so a repeated tap (the add is idempotent) adds
// no second line.
wishlistHistorySchema.index({ businessId: 1, userId: 1, wishlistItemId: 1 }, { unique: true });
// The list's order, tie-break included (historyPage), for the owner (the
// shop's) and for an employee (their own).
wishlistHistorySchema.index({ businessId: 1, userId: 1, createdAt: -1, _id: -1 });
wishlistHistorySchema.index({ businessId: 1, createdAt: -1, _id: -1 });
wishlistHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: WISHLIST_HISTORY_TTL_SECONDS });

const WishlistHistory = mongoose.model('WishlistHistory', wishlistHistorySchema);
WishlistHistory.WISHLIST_HISTORY_TTL_SECONDS = WISHLIST_HISTORY_TTL_SECONDS;

module.exports = WishlistHistory;

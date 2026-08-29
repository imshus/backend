const mongoose = require('mongoose');

/**
 * Wishlist Item – permanently persisted in MongoDB when the user
 * presses "Add to Wishlist" on the scan-results screen.
 *
 * All scan state lives in Redis until this point.
 */
const wishlistSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
  
    itemId: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    tagCode: {
      type: String,
      required: true,
      trim: true,
    },
    // Total MRP in ₹ (number, no formatting here)
    totalMrp: {
      type: Number,
      required: true,
      default: 0,
    },
    // Formatted price badge string, e.g. "₹ 1,84,500"
    priceBadge: {
      type: String,
      default: '',
    },
    calculationRate: {
      type: String,
      enum: ['rtgs', 'cash'],
    },
    // ISO string – time the scan session was created
    scanTimestamp: {
      type: String,
      required: true,
    },
 
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

// Compound indices for efficient lookups and uniqueness per user within a business
wishlistSchema.index({ businessId: 1, userId: 1, createdAt: -1 });
wishlistSchema.index({ businessId: 1, userId: 1, itemId: 1 }, { unique: true });

module.exports = mongoose.model('Wishlist', wishlistSchema);

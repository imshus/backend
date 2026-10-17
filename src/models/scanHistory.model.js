const mongoose = require('mongoose');

// Kept for six months, then dropped by MongoDB itself (the TTL index below),
// so a busy counter's history cannot grow without bound.
const SCAN_HISTORY_TTL_SECONDS = 180 * 24 * 60 * 60;

/**
 * One priced scan, for Settings -> History -> Tag scan history.
 *
 * Written by POST /scans/:scanId/calculate every time it returns a price,
 * one record per scan: a later price for the same scan (the card edited and
 * priced again) replaces the earlier one. A scan's state lives in Redis and
 * ends with it, so this is the only lasting trace of a scan that was never
 * wishlisted or billed.
 */
const scanHistorySchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
    },
    // The account that scanned it, as invoices and wishlist items carry it:
    // the owner's business_users id, or the Employee document's for an
    // employee. An employee sees only their own; the owner sees the shop's.
    userId: {
      type: String,
      required: true,
    },
    scanId: {
      type: String,
      required: true,
    },
    // The Masters item's name when the tag matched one, else the karat and
    // type that were priced ("22K Gold", "18K Diamond Jewellery").
    itemName: {
      type: String,
      default: '',
      trim: true,
    },
    karat: {
      type: String,
      default: '',
    },
    // The tag's serial / item number as the card shows it; '' when none.
    tagCode: {
      type: String,
      default: '',
      trim: true,
    },
    // The price to the rupee, as the card shows and the invoice bills it.
    finalMRP: {
      type: Number,
      required: true,
      default: 0,
    },
    // When the request that priced it arrived. A price only replaces one
    // asked for before it, so two in flight for one scan leave the later
    // request's, whichever finishes last.
    pricedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    collection: 'scan_history',
  },
);

scanHistorySchema.index({ businessId: 1, scanId: 1 }, { unique: true });
// The list's order, tie-break included (scanHistory.service listScans), so a
// History open reads the lines it shows rather than sorting the whole shop's.
scanHistorySchema.index({ businessId: 1, userId: 1, createdAt: -1, _id: -1 });
scanHistorySchema.index({ businessId: 1, createdAt: -1, _id: -1 });
scanHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: SCAN_HISTORY_TTL_SECONDS });

const ScanHistory = mongoose.model('ScanHistory', scanHistorySchema);
ScanHistory.SCAN_HISTORY_TTL_SECONDS = SCAN_HISTORY_TTL_SECONDS;

module.exports = ScanHistory;

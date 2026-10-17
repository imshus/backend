const mongoose = require('mongoose');

// Kept for six months, then dropped by MongoDB itself (the TTL index below),
// so a busy counter's history cannot grow without bound.
const SCAN_HISTORY_TTL_SECONDS = 180 * 24 * 60 * 60;

// What a line has been through: 'read' once the analysis returned a reading
// (POST /scans/:scanId/analyze), 'priced' once the card asked for a price
// (POST /scans/:scanId/calculate). A line written before the reading was
// kept has no status and was priced.
const SCAN_HISTORY_STATUSES = ['read', 'priced'];

/**
 * One scan, for Settings -> History -> Tag scan history, from the moment
 * the tag is read.
 *
 * The analysis starts the line with everything it read (`details`) and the
 * price it worked out from the reading, if any; every price the card asks
 * for afterwards updates it (`pricing`, the latest price replacing an
 * earlier one). One record per scan. A scan's state lives in Redis (or
 * memory) and ends with it, so this is the only lasting trace of a scan that
 * was never wishlisted or billed.
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
    status: {
      type: String,
      enum: SCAN_HISTORY_STATUSES,
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
    // The price to the rupee, as the card shows and the invoice bills it:
    // the one worked out from the reading until the card asks for its own.
    // Null for a reading that could not be priced (no live rate).
    finalMRP: {
      type: Number,
      default: null,
    },
    // Everything the analysis read off the tag, as plain values
    // (scanHistory.service readingDetailsOf). Null on a line written before
    // readings were kept.
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // The latest price the card asked for: the inputs it sent and the
    // breakdown it was answered with (scanHistory.service pricingRecordOf).
    // Null until the card asks.
    pricing: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
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
// The list's order, tie-break included (historyPage), so a History open
// reads the lines it shows rather than sorting the whole shop's.
scanHistorySchema.index({ businessId: 1, userId: 1, createdAt: -1, _id: -1 });
scanHistorySchema.index({ businessId: 1, createdAt: -1, _id: -1 });
scanHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: SCAN_HISTORY_TTL_SECONDS });

const ScanHistory = mongoose.model('ScanHistory', scanHistorySchema);
ScanHistory.SCAN_HISTORY_TTL_SECONDS = SCAN_HISTORY_TTL_SECONDS;
ScanHistory.SCAN_HISTORY_STATUSES = SCAN_HISTORY_STATUSES;

module.exports = ScanHistory;

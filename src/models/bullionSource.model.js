const mongoose = require('mongoose');

/**
 * Which bullion house a shop's Home rate follows, and the houses it added
 * itself.
 *
 * Two houses — JMD Patil and Mega Bullion — publish to the live bhaw feed and
 * are always offered. A shop can add its own: that name is a choice to follow
 * no vendor at all, so the rate becomes MCX plus the shop's own RTGS and Cash
 * changes from Gold Rate Settings.
 *
 * Per user, like the rest of the dashboard settings: the owner's record is the
 * shop's, and an employee who chooses their own house gets their own.
 */
const bullionSourceSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
    index: true
  },
  // 'jmd_patil', 'mega_bullion', or the name of a house the shop added.
  selected: {
    type: String,
    trim: true,
    default: ''
  },
  // The houses this shop added, in the order they were added.
  customNames: {
    type: [String],
    default: []
  }
}, {
  timestamps: true,
  collection: 'bullion_sources'
});

bullionSourceSchema.index({ businessId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('BullionSource', bullionSourceSchema);

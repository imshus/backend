const mongoose = require('mongoose');

/**
 * Which bullion house a shop's Home rate follows, and the houses it has asked
 * us to add.
 *
 * Two houses — JMD Patil and Mega Bullion — publish to the live bhaw feed and
 * are the only ones that can be followed. A shop may also ask for a house of
 * its own: that name is recorded here as a request, answered when its rates
 * can be fed, and never affects the shop's price in the meantime.
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
  // 'jmd_patil' or 'mega_bullion' — the house whose bhaw Home follows.
  selected: {
    type: String,
    trim: true,
    default: ''
  },
  // Houses the shop has asked us to add, in the order they were asked for.
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

const mongoose = require('mongoose');

/**
 * Which bullion house a shop's Home rate follows, and the houses it has asked
 * us to add.
 *
 * Every house on the 3-minute bhaw feed can be followed, by its key on the
 * feed (services/bullionHouses.js). A shop may also ask for a house of its
 * own: that name is recorded here as a request, answered when its rates can
 * be fed (the house then appears on the feed and is picked like any other),
 * and never affects the shop's price in the meantime.
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
  // A house's key on the feed ('jmd_patil', 'smd_bullion', …) — the house
  // whose bhaw Home follows and scans are priced on.
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

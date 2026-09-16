const mongoose = require('mongoose');

const colorstoneRateSchema = new mongoose.Schema({
  // The shop's rows have no userId; an employee who edits colorstone rates
  // gets their own private copy of the table under their userId.
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
    index: true
  },
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  // The packet the stones came in. A rate can be filed under the code alone,
  // the way a diamond rate can.
  packetCode: {
    type: String,
    trim: true,
    default: ''
  },
  color: {
    type: String,
    trim: true,
    default: ''
  },
  clarity: {
    type: String,
    trim: true,
    default: ''
  },
  rate: {
    type: Number,
    required: true
  }
}, {
  timestamps: true,
  collection: 'colorstone_rates'
});

// One row per colour + clarity, but only for rows without a packet code:
// a packet's rate is identified by its code instead.
colorstoneRateSchema.index(
  { businessId: 1, userId: 1, color: 1, clarity: 1 },
  {
    unique: true,
    partialFilterExpression: {
      packetCode: { $in: [null, ''] }
    }
  }
);
// One row per packet code (non-empty only).
colorstoneRateSchema.index(
  { businessId: 1, userId: 1, packetCode: 1 },
  { unique: true, partialFilterExpression: { packetCode: { $gt: '' } } }
);

module.exports = mongoose.model('ColorstoneRate', colorstoneRateSchema);

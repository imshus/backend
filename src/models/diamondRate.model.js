const mongoose = require('mongoose');

const diamondRateSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
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
  packetCode: {
    type: String,
    trim: true,
    default: ''
  },
  shape: {
    type: mongoose.Schema.Types.Mixed,
    default: 0
  },
  rate: {
    type: Number,
    required: true
  }
}, {
  timestamps: true,
  collection: 'diamond_rates'
});

// Ensure uniqueness for a business based on color, clarity, and shape
// Only enforce this when packetCode is not set (packet-code-only entries are handled by a separate index).
diamondRateSchema.index(
  { businessId: 1, color: 1, clarity: 1, shape: 1 },
  {
    unique: true,
    partialFilterExpression: {
      packetCode: { $in: [null, ''] }
    }
  }
);
// Ensure uniqueness for packet codes within a business (non-empty only)
diamondRateSchema.index(
  { businessId: 1, packetCode: 1 },
  { unique: true, partialFilterExpression: { packetCode: { $gt: '' } } }
);

module.exports = mongoose.model('DiamondRate', diamondRateSchema);

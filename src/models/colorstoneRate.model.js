const mongoose = require('mongoose');

const colorstoneRateSchema = new mongoose.Schema({
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
  rate: {
    type: Number,
    required: true
  }
}, {
  timestamps: true,
  collection: 'colorstone_rates'
});

// Ensure uniqueness for a business based on color and clarity
colorstoneRateSchema.index({ businessId: 1, color: 1, clarity: 1 }, { unique: true });

module.exports = mongoose.model('ColorstoneRate', colorstoneRateSchema);

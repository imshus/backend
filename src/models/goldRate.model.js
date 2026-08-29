const mongoose = require('mongoose');

const goldRateSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  carat: {
    type: String,
    required: true,
    enum: ['22Kt', '20Kt', '18Kt', '14Kt', '9Kt'],
    trim: true 
  },
  purity: {
    type: Number,
    required: true 
  },
  increaseByAmount: {
    type: Number,
    default: 0
  },
  increaseByType: {
    type: String,
    enum: ['FLAT', 'PERCENTAGE'],
    default: 'FLAT'
  },
  isHidden: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true,
  collection: 'gold_rates'
});


goldRateSchema.index({ businessId: 1, carat: 1 }, { unique: true });

module.exports = mongoose.model('GoldRate', goldRateSchema);

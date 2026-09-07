const mongoose = require('mongoose');

/**
 * The adjustments a shop applies to the live MCX rate. One record per
 * business (the owner's, with no userId — the shop's default) plus one per
 * employee who has saved their own.
 */
const goldTaxSettingSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  userId: {
    type: String,
    default: null,
    index: true
  },
  mcxChange: {
    operation: {
      type: String,
      enum: ['+', '-'],
      default: '+'
    },
    amount: {
      type: Number,
      default: 0
    }
  },
  rtgsChangeBy: {
    type: Number,
    default: 0
  },
  cashChangeBy: {
    type: Number,
    default: 0
  },
  scannerCalculationUse: {
    type: String,
    enum: ['rtgs', 'cash'],
    default: 'rtgs'
  }
}, {
  timestamps: true,
  collection: 'gold_tax_settings'
});

goldTaxSettingSchema.index({ businessId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('GoldTaxSetting', goldTaxSettingSchema);

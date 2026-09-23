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
  },
  // The shop's RTGS rate comes in two forms. RTGS Rate 1 is the base as it
  // comes from MCX, bhaw and the shop's change, nothing on it. RTGS Rate 2
  // carries whatever percent the shop enters here — none to begin with, so
  // a shop from before this setting, which is on Rate 2, prices exactly as
  // it always had. `rtgsVariant` says which one the app prices on.
  rtgsTaxPercent: {
    type: Number,
    default: 0
  },
  rtgsVariant: {
    type: String,
    enum: ['taxed', 'plain'],
    default: 'plain'
  }
}, {
  timestamps: true,
  collection: 'gold_tax_settings'
});

goldTaxSettingSchema.index({ businessId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('GoldTaxSetting', goldTaxSettingSchema);

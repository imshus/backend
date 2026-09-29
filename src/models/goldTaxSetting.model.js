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
  // The shop's RTGS rate comes in two forms. RTGS Rate 1 is the board
  // figure (MCX, bhaw and the shop's change) with no tax on it. RTGS
  // Rate 2 (without tax) is the board figure less whatever percent the shop
  // types in its Tax box — 0 until it does, so the board figure itself.
  // `rtgsVariant` says which one the app prices on: Rate 1 (the board
  // figure, no tax) unless the shop ticked Rate 2. With the Tax box at 0 the
  // two are the same figure, so a record left on Rate 2 prices the same.
  rtgsTaxPercent: {
    type: Number,
    default: 0
  },
  rtgsVariant: {
    type: String,
    enum: ['taxed', 'plain'],
    default: 'taxed'
  }
}, {
  timestamps: true,
  collection: 'gold_tax_settings'
});

goldTaxSettingSchema.index({ businessId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('GoldTaxSetting', goldTaxSettingSchema);

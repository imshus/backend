const mongoose = require('mongoose');

/**
 * One record per business (the owner's, with no userId — the shop's
 * default) plus one per employee who has saved their own.
 */
const formulaConfigSchema = new mongoose.Schema({
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
  activeFormula: {
    type: String,
    enum: ['F1', 'F2'],
    default: 'F1'
  },
  formula2Rules: {
    type: [String],
    default: ['14K']
  }
}, {
  timestamps: true,
  collection: 'formula_configs'
});

formulaConfigSchema.index({ businessId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('FormulaConfig', formulaConfigSchema);

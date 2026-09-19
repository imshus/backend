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
  /**
   * How a sales invoice groups what was scanned (Masters → Sales Invoice):
   *
   *   SEPARATE           Gold, Diamond, Labour each on their own line + Tax
   *   GOLD_WITH_LABOUR   (Gold + Labour), Diamond + Tax
   *   GOLD_WITH_WASTAGE  (Gold + Wastage), Diamond + Tax
   *
   * Per user like the rest of this record: the owner's choice is the shop's,
   * and an employee who picks another keeps their own.
   */
  salesInvoiceLayout: {
    type: String,
    enum: ['SEPARATE', 'GOLD_WITH_LABOUR', 'GOLD_WITH_WASTAGE'],
    default: 'SEPARATE'
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

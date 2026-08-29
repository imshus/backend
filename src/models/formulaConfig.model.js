const mongoose = require('mongoose');

const formulaConfigSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    unique: true
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

module.exports = mongoose.model('FormulaConfig', formulaConfigSchema);

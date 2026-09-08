const mongoose = require('mongoose');

const labourRateSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    // The shop's row has no userId; an employee who saves a labour charge
    // keeps their own row. A NONE row is a saved "no labour charge" choice —
    // deleting the row instead would fall back to the shop's charge.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    chargeType: {
      type: String,
      required: true,
      enum: ['AMOUNT', 'PERCENTAGE', 'NONE'],
    },
    value: {
      type: Number,
      required: function () {
        return this.chargeType !== 'NONE';
      },
      min: 0,
    },
    rupeesUnit: {
      type: String,
      enum: ['Per Gram', 'Per 10 Gram'],
      required: function () {
        return this.chargeType === 'AMOUNT';
      },
    },
    // Which weight the rate is charged against. Older records predate the
    // setting, so they keep the app's long-standing gross-weight behaviour.
    weightBasis: {
      type: String,
      enum: ['net', 'gross'],
      // Net weight is the default basis; a rate saved before this field
      // existed resolves to net rather than gross.
      default: 'net',
    },
  },
  {
    timestamps: true,
    collection: 'labour_rates',
  },
);

labourRateSchema.index({ businessId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('LabourRate', labourRateSchema);

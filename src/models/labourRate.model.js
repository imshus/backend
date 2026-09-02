const mongoose = require('mongoose');

const labourRateSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      unique: true,
      index: true,
    },
    chargeType: {
      type: String,
      required: true,
      enum: ['AMOUNT', 'PERCENTAGE'],
    },
    value: {
      type: Number,
      required: true,
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

module.exports = mongoose.model('LabourRate', labourRateSchema);

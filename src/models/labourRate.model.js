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
  },
  {
    timestamps: true,
    collection: 'labour_rates',
  },
);

module.exports = mongoose.model('LabourRate', labourRateSchema);

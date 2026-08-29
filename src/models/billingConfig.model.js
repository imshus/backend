const mongoose = require('mongoose');

const billingConfigSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      required: true,
      unique: true,
      default: 'GLOBAL',
      enum: ['GLOBAL'],
    },
    erf: {
      type: Number,
      default: 97,
      min: 1,
    },
    inputTokenPricePerMillionUsd: {
      type: Number,
      default: 0.2,
      min: 0,
    },
    outputTokenPricePerMillionUsd: {
      type: Number,
      default: 1.2,
      min: 0,
    },
    kComp: {
      type: Number,
      default: 0.27,
      min: 0,
    },
    aComp: {
      type: Number,
      default: 0.15,
      min: 0,
    },
    applicationPrice: {
      type: Number,
      default: 12000,
      min: 0,
    },
    freeTrialCredits: {
      type: Number,
      default: 100,
      min: 0,
    },
    purchasedBonusCredits: {
      type: Number,
      default: 1000,
      min: 0,
    },
    trialDays: {
      type: Number,
      default: 10,
      min: 1,
    },
    lowCreditThreshold: {
      type: Number,
      default: 20,
      min: 0,
    },
    criticalCreditThreshold: {
      type: Number,
      default: 10,
      min: 0,
    },
    webhookSecret: {
      type: String,
      default: '',
      trim: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'billing_config',
  }
);

module.exports = mongoose.model('BillingConfig', billingConfigSchema);

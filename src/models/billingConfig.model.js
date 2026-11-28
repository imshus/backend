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
    // OpenAI priority (Fast mode) rates for gpt-6-luna, the tier every scan
    // read runs on: $0.20 a million in, $1.00 a million out.
    outputTokenPricePerMillionUsd: {
      type: Number,
      default: 1.0,
      min: 0,
    },
    /** What the shop pays per rupee a scan costs us. 2 = double (owner, 28 Nov 2026). */
    marginMultiplier: {
      type: Number,
      default: 2,
      min: 0,
    },
    // The flat per-scan lines, both 0: a scan is charged exactly double what
    // it cost and nothing else (owner, 28 Nov 2026). Kept so a flat line can
    // be put back from billing settings without a deploy.
    kComp: {
      type: Number,
      default: 0,
      min: 0,
    },
    aComp: {
      type: Number,
      default: 0,
      min: 0,
    },
    applicationPrice: {
      type: Number,
      default: 15000,
      min: 0,
    },
    freeTrialCredits: {
      type: Number,
      default: 10,
      min: 0,
    },
    purchasedBonusCredits: {
      type: Number,
      default: 1000,
      min: 0,
    },
    trialDays: {
      type: Number,
      default: 7,
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
    // The least a wallet must hold, above this, for a new scan to start. A
    // scan is billed only once it is done and only if the wallet covers the
    // whole charge, so a balance at or under this could run a scan the wallet
    // then cannot pay for. Moved with the margin, 28 Nov 2026: the token part
    // of a scan bills at double cost and the flat line is gone, so the old 0.74
    // (0.47 of tokens plus a 0.27 flat line) becomes 0.47 x 2.
    minScanBalance: {
      type: Number,
      default: 0.94,
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

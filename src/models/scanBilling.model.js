const mongoose = require('mongoose');

const scanBillingSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    scanId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    model: {
      type: String,
      default: '',
      trim: true,
    },
    provider: {
      type: String,
      default: 'openai',
      trim: true,
    },
    promptTokens: {
      type: Number,
      default: 0,
      min: 0,
    },
    completionTokens: {
      type: Number,
      default: 0,
      min: 0,
    },
    inputCostUsd: {
      type: Number,
      default: 0,
      min: 0,
    },
    outputCostUsd: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalUsd: {
      type: Number,
      default: 0,
      min: 0,
    },
    erf: {
      type: Number,
      default: 97,
      min: 0,
    },
    lComp: {
      type: Number,
      default: 0,
      min: 0,
    },
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
    totalScanCharge: {
      type: Number,
      default: 0,
      min: 0,
    },
    billingStatus: {
      type: String,
      enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'RECONCILIATION_REQUIRED'],
      default: 'SUCCEEDED',
      index: true,
    },
    failureReason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    balanceBefore: {
      type: Number,
      default: 0,
      min: 0,
    },
    balanceAfter: {
      type: Number,
      default: 0,
      min: 0,
    },
    billedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'scan_billing',
  }
);

module.exports = mongoose.model('ScanBilling', scanBillingSchema);

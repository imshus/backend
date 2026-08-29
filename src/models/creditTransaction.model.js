const mongoose = require('mongoose');

const creditTransactionSchema = new mongoose.Schema(
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
    actionByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: [
        'TRIAL_CREDIT',
        'BONUS',
        'PURCHASE_BONUS',
        'PROMOTIONAL_BONUS',
        'REFERRAL_BONUS',
        'COUPON_BONUS',
        'MANUAL_BONUS',
        'FESTIVAL_BONUS',
        'SCAN_DEDUCTION',
        'CREDIT_ADD',
        'CREDIT_REMOVE',
        'CREDIT_SET',
        'CREDIT_RESET',
        'TRIAL_EXPIRY_RESET',
      ],
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
      set: (value) => Number(Number(value || 0).toFixed(2)),
    },
    balanceBefore: {
      type: Number,
      required: true,
      min: 0,
      set: (value) => Number(Number(value || 0).toFixed(2)),
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
      set: (value) => Number(Number(value || 0).toFixed(2)),
    },
    note: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    collection: 'credit_transactions',
  }
);

creditTransactionSchema.index(
  { type: 1, 'metadata.scanId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      type: 'SCAN_DEDUCTION',
      'metadata.scanId': { $exists: true },
    },
  }
);

module.exports = mongoose.model('CreditTransaction', creditTransactionSchema);

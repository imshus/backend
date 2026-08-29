const mongoose = require('mongoose');

const paymentTransactionSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    initiatedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    paymentType: {
      type: String,
      enum: ['APPLICATION_PURCHASE', 'CREDIT_RECHARGE'],
      required: true,
      index: true,
    },
    orderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    paymentId: {
      type: String,
      default: undefined,
      trim: true,
    },
    receipt: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    amountInPaise: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'INR',
      trim: true,
    },
    creditsPurchased: {
      type: Number,
      default: 0,
      min: 0,
    },
    gstAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    baseAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: [
        'ORDER_CREATED',
        'PAYMENT_PENDING',
        'PAYMENT_SUCCESS',
        'PAYMENT_FAILED',
        'PAYMENT_CANCELLED',
        'PAYMENT_TIMEOUT',
        'VERIFICATION_FAILED',
        'REFUNDED',
      ],
      default: 'ORDER_CREATED',
      index: true,
    },
    invoiceNumber: {
      type: String,
      default: null,
      index: true,
    },
    invoiceDate: {
      type: Date,
      default: null,
    },
    organizationLegalName: {
      type: String,
      default: '',
      trim: true,
    },
    organizationGstNumber: {
      type: String,
      default: '',
      trim: true,
    },
    organizationTradeName: {
      type: String,
      default: '',
      trim: true,
    },
    razorpaySignature: {
      type: String,
      default: null,
    },
    gatewayResponse: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    verificationAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    failureReason: {
      type: String,
      default: '',
      trim: true,
    },
    idempotencyKey: {
      type: String,
      default: null,
      index: true,
    },
    walletCredited: {
      type: Boolean,
      default: false,
      index: true,
    },
    applicationActivated: {
      type: Boolean,
      default: false,
      index: true,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    capturedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'payment_transactions',
  }
);

// Enforce uniqueness only for real captured payment IDs, not pending null/empty values.
paymentTransactionSchema.index(
  { paymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paymentId: { $type: 'string', $nin: ['', null] },
    },
  },
);

module.exports = mongoose.model('PaymentTransaction', paymentTransactionSchema);

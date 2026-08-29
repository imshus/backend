const mongoose = require('mongoose');

const licenseTransactionSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    paymentTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentTransaction',
      default: null,
      index: true,
    },
    orderId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    paymentId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['LICENSE', 'BONUS'],
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      default: 0,
      min: 0,
    },
    credits: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ['SUCCESS', 'FAILED', 'REVERSED'],
      default: 'SUCCESS',
      index: true,
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
    collection: 'license_transactions',
  }
);

module.exports = mongoose.model('LicenseTransaction', licenseTransactionSchema);

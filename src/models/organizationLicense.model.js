const mongoose = require('mongoose');

const organizationLicenseSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      unique: true,
      index: true,
    },
    licenseStatus: {
      type: String,
      enum: ['NO_LICENSE', 'FREE_TRIAL_LICENSE', 'PERMANENT_LICENSE'],
      default: 'NO_LICENSE',
      required: true,
      index: true,
    },
    trialDays: {
      type: Number,
      default: 10,
      min: 1,
    },
    trialCredits: {
      type: Number,
      default: 100,
      min: 0,
    },
    trialStartDate: {
      type: Date,
      default: null,
    },
    trialEndDate: {
      type: Date,
      default: null,
    },
    trialExpiredAt: {
      type: Date,
      default: null,
    },
    permanentActivatedAt: {
      type: Date,
      default: null,
    },
    purchaseDate: {
      type: Date,
      default: null,
    },
    purchaseAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    purchaseOrderId: {
      type: String,
      default: null,
      trim: true,
    },
    purchasePaymentId: {
      type: String,
      default: null,
      trim: true,
    },
    purchaseInvoiceNumber: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,
    collection: 'organization_licenses',
  }
);

module.exports = mongoose.model('OrganizationLicense', organizationLicenseSchema);

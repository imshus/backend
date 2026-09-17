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
    // Whose licence this is. A GSTIN may cover several shops, so the licence
    // belongs to the owner's account — and is findable by the number that
    // account signs in with, which is what support is given to search on.
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BusinessUser',
      default: null,
      index: true,
    },
    ownerPhone: {
      type: String,
      default: '',
      trim: true,
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
      // Seven days, matching the billing config this is normally written from.
      default: 7,
      min: 1,
    },
    trialCredits: {
      type: Number,
      default: 10,
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

const mongoose = require('mongoose');

const organizationWalletSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      unique: true,
      index: true,
    },
    creditBalance: {
      type: Number,
      default: 0,
      min: 0,
      set: (value) => Number(Number(value || 0).toFixed(2)),
    },
    lifetimeScans: {
      type: Number,
      default: 0,
      min: 0,
    },
    monthScans: {
      type: Number,
      default: 0,
      min: 0,
    },
    todayScans: {
      type: Number,
      default: 0,
      min: 0,
    },
    statsMonthKey: {
      type: String,
      default: null,
    },
    statsDayKey: {
      type: String,
      default: null,
    },
    lastScanCost: {
      type: Number,
      default: 0,
      min: 0,
      set: (value) => Number(Number(value || 0).toFixed(2)),
    },
    lastScanAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'organization_wallets',
  }
);

module.exports = mongoose.model('OrganizationWallet', organizationWalletSchema);

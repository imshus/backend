const mongoose = require('mongoose');

const organizationSubscriptionSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      unique: true,
      index: true,
    },
    trialStatus: {
      type: String,
      enum: ['NOT_STARTED', 'ACTIVE', 'EXPIRED'],
      default: 'NOT_STARTED',
      required: true,
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
    applicationPurchased: {
      type: Boolean,
      default: false,
      index: true,
    },
    purchaseAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    purchaseDate: {
      type: Date,
      default: null,
    },
    bonusCredits: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    collection: 'organization_subscriptions',
  }
);

module.exports = mongoose.model('OrganizationSubscription', organizationSubscriptionSchema);

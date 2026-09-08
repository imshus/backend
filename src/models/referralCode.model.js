const mongoose = require('mongoose');

/**
 * One personal Earn & Invite code per signed-in account — the owner and each
 * employee of a business each carry their own. Generated the first time that
 * person opens the screen. Rewards always credit the business wallet; the
 * code decides who gets the credit for bringing the referral in.
 */
const referralCodeSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
  },
  {
    timestamps: true,
    collection: 'referral_codes',
  },
);

referralCodeSchema.index({ businessId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('ReferralCode', referralCodeSchema);

const mongoose = require('mongoose');

/**
 * Every GST number checked while creating an account, passed or not, with the
 * name and mobile entered on the sign-up form, so the shop can be followed up
 * whether or not an account came of it.
 *
 * One row per mobile and GST number, holding the latest outcome: the details
 * GSTN returned when it verified, the reason it was refused when it did not,
 * and counts of both. A failed number is marked resolved once the same mobile
 * verifies any GST number; confirmedAt and businessId are set when the
 * account is actually created with it.
 */
const gstDetailsSchema = new mongoose.Schema({
  legalName: { type: String, default: '' },
  tradeName: { type: String, default: '' },
  businessType: { type: String, default: '' },
  companyType: { type: String, default: '' },
  address: { type: String, default: '' },
  stateCode: { type: String, default: '' },
  stateName: { type: String, default: '' },
  pincode: { type: String, default: '' },
  gstStatus: { type: String, default: '' },
  // GST_VERIFY_MODE=mock stub data, never real GSTN details.
  isMock: { type: Boolean, default: false },
}, { _id: false });

const gstVerificationSchema = new mongoose.Schema({
  gstNumber: { type: String, required: true, trim: true, uppercase: true },
  fullName: { type: String, default: '', trim: true },
  // Last ten digits; '' when an app from before this sent none.
  mobile: { type: String, default: '' },
  source: { type: String, enum: ['REGISTRATION'], default: 'REGISTRATION' },

  // The latest outcome for this mobile and number.
  status: { type: String, enum: ['VERIFIED', 'FAILED'], required: true },
  attempts: { type: Number, default: 0 },
  failures: { type: Number, default: 0 },

  // From the last successful check.
  details: { type: gstDetailsSchema, default: null },
  verifiedAt: { type: Date, default: null },

  // From the last failed check: what the person was told, and why.
  reason: { type: String, default: '' },
  errorCode: { type: String, default: '' },
  statusCode: { type: Number, default: null },
  lastFailedAt: { type: Date, default: null },

  firstCheckedAt: { type: Date, default: null },
  lastCheckedAt: { type: Date, default: null },

  // A failed number whose mobile later verified a GST number.
  resolvedAt: { type: Date, default: null },
  resolvedGstNumber: { type: String, default: '' },

  // The account was created with this number.
  confirmedAt: { type: Date, default: null },
  businessId: { type: String, default: '' },
}, {
  timestamps: true,
  collection: 'gst_verifications',
});

gstVerificationSchema.index({ mobile: 1, gstNumber: 1 }, { unique: true });
gstVerificationSchema.index({ status: 1, lastCheckedAt: -1 });

module.exports = mongoose.model('GstVerification', gstVerificationSchema);

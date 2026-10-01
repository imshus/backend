const mongoose = require('mongoose');

/**
 * A GST number someone could not verify while creating an account, with the
 * name and mobile they had entered, so the shop can be followed up even
 * though no account was made. One row per mobile and GST number: repeat
 * failures count up on it, and a later successful check from the same
 * mobile marks it resolved.
 */
const gstVerificationFailureSchema = new mongoose.Schema({
  gstNumber: { type: String, required: true, trim: true, uppercase: true },
  fullName: { type: String, default: '', trim: true },
  // Last ten digits; '' when an app from before this sent none.
  mobile: { type: String, default: '' },
  source: { type: String, enum: ['REGISTRATION'], default: 'REGISTRATION' },
  // What the person was told, and the error behind it.
  reason: { type: String, default: '' },
  errorCode: { type: String, default: '' },
  statusCode: { type: Number, default: null },
  attempts: { type: Number, default: 0 },
  firstFailedAt: { type: Date, default: null },
  lastFailedAt: { type: Date, default: null },
  // Set when the same mobile later verifies a GST number successfully.
  resolvedAt: { type: Date, default: null },
  resolvedGstNumber: { type: String, default: '' },
}, {
  timestamps: true,
  collection: 'gst_verification_failures',
});

gstVerificationFailureSchema.index({ mobile: 1, gstNumber: 1 }, { unique: true });
gstVerificationFailureSchema.index({ lastFailedAt: -1 });

module.exports = mongoose.model('GstVerificationFailure', gstVerificationFailureSchema);

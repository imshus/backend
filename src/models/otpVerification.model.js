const mongoose = require('mongoose');

const otpVerificationSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: false
  },
  otpType: {
    type: String,
    enum: ['PHONE', 'MOBILE'],
    required: true
  },
  destination: {
    type: String,
    required: false
  },
  mobile: {
    type: String,
    required: false,
    index: true
  },
  otp: {
    type: String,
    required: false
  },
  otpHash: {
    type: String,
    required: false
  },
  verified: {
    type: Boolean,
    default: false
  },
  requestId: {
    type: String,
    required: false
  },
  msg91Response: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  },
  status: {
    type: String,
    enum: ['GENERATED', 'SENT', 'VERIFIED', 'FAILED'],
    default: 'GENERATED'
  },
  flow: {
    type: String,
    required: false,
    default: 'GENERAL'
  },
  expiresAt: {
    type: Date,
    required: false
  }
}, {
  timestamps: true, 
  collection: 'otp_verifications'
});
otpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OtpVerification', otpVerificationSchema);

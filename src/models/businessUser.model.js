const mongoose = require('mongoose');

const businessUserSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  phone: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  // The person who owns the account, as typed on the signup form. Blank on
  // accounts created before it was stored (it used to live only on the phone).
  fullName: {
    type: String,
    default: '',
    trim: true
  },
  // Chosen at signup; unique across all users. Sparse so accounts created
  // before this field existed (phone-only) stay valid.
  userId: {
    type: String,
    unique: true,
    sparse: true,
    trim: true
  },
  // Copied from the business at registration so a user record carries the
  // GST-verified address directly. Kept in sync when the GSTIN is re-confirmed.
  address: {
    type: String,
    default: '',
    trim: true
  },
  gstNumber: {
    type: String,
    default: '',
    trim: true,
    uppercase: true
  },
  businessName: {
    type: String,
    default: '',
    trim: true
  },
  // What an owner signs in with now: four digits, hashed the way the password
  // was. An account that predates it has no mpinHash and is asked to set one
  // over an OTP rather than being locked out, so this cannot be required.
  mpinHash: {
    type: String
  },
  // Kept for those accounts until they set an MPIN, and for employees, whose
  // credential is still a password.
  passwordHash: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['OWNER', 'EMP', 'SUPER'],
    default: 'OWNER',
    required: true
  },
  phoneVerified: {
    type: Boolean,
    default: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLoginAt: {
    type: Date
  },
  passwordResetNonceHash: {
    type: String,
    select: false
  },
  passwordResetExpiresAt: {
    type: Date,
    select: false
  }
}, {
  timestamps: true,
  collection: 'business_users'
});

module.exports = mongoose.model('BusinessUser', businessUserSchema);

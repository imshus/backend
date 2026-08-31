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

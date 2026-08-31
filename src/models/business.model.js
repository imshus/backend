const mongoose = require('mongoose');

const businessSchema = new mongoose.Schema({
  gstNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  legalName: {
    type: String,
    required: true
  },
  tradeName: {
    type: String,
    required: true
  },
  businessType: {
    type: String,
    required: true
  },
  companyType: {
    type: String
  },
  gstStatus: {
    type: String,
    required: true
  },
  address: {
    type: String,
    required: true
  },
  stateCode: {
    type: String
  },
  stateName: {
    type: String
  },
  pincode: {
    type: String
  },
  registrationStep: {
    type: String,
    enum: [
      'GST_CONFIRMED',
      'CONTACT_DETAILS_SUBMITTED',
      'PHONE_VERIFIED',
      'OTP_VERIFIED',
      'PASSWORD_CREATED',
      'COMPLETED'
    ],
    default: 'GST_CONFIRMED'
  },
  // Printed on the tax invoice. Optional so existing businesses stay valid.
  bankName: { type: String, default: '' },
  bankBranch: { type: String, default: '' },
  bankAccountNumber: { type: String, default: '' },
  bankIfsc: { type: String, default: '' },
  invoiceTerms: { type: [String], default: [] },
  isRegistered: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Business', businessSchema);

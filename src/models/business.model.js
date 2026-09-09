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
  // ── Referral programme ──────────────────────────────────────────────
  // Codes are personal and live in the referral_codes collection; the
  // referred side is recorded here. Business whose member's code was entered
  // when this one registered, and which member's.
  referredByBusinessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    default: null,
    index: true
  },
  referredByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
    index: true
  },
  // The code string itself as entered at registration, kept for the record.
  referredByCode: {
    type: String,
    default: '',
    trim: true,
    uppercase: true
  },
  // Stamped when the referrer's invite reward was paid for this business —
  // at most once, on its first licence (trial start or purchase).
  referralRewardedAt: {
    type: Date,
    default: null
  },
  // Stamped when the referrer's larger purchase reward was paid — at most
  // once, when this business bought the application.
  referralPurchaseRewardedAt: {
    type: Date,
    default: null
  },
  // ── Government e-invoicing (IRP) ────────────────────────────────────
  // Per business: the owner saves the API user they created for their own
  // GSTIN on einvoice1.gst.gov.in. The password is AES-encrypted with the
  // server's EINVOICE_CRED_KEY and is never returned by any API.
  eInvoiceEnabled: {
    type: Boolean,
    default: false
  },
  eInvoiceUsername: {
    type: String,
    default: '',
    trim: true
  },
  eInvoicePasswordEnc: {
    type: String,
    default: ''
  },
  isRegistered: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Business', businessSchema);

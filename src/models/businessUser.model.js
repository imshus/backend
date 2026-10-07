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
  // GST-verified address directly. Kept in sync when the GSTIN is re-confirmed
  // or changed on the Profile screen. An employee's record (role EMP) carries
  // the shop's copy, taken from the owner's record and refreshed with it: the
  // same shop, never a separate business or GST registration.
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
  // The same MPIN sealed under the server's key (utils/mpinVault), so the
  // OTP-guarded Forgot MPIN screen can show it back. Never consulted by
  // login, and `select: false` keeps it out of every ordinary query.
  mpinVault: {
    type: String,
    default: null,
    select: false
  },
  // Kept for those accounts until they set an MPIN. An employee's sign-in
  // record (role EMP) has none: its credential is the MPIN the owner sets, and
  // the legacy employee password lives on the Employee document.
  passwordHash: {
    type: String,
    required: function requiredUnlessEmployee() {
      return this.role !== 'EMP';
    }
  },
  role: {
    type: String,
    enum: ['OWNER', 'EMP', 'SUPER'],
    default: 'OWNER',
    required: true
  },
  // An employee signs in through the same phone + OTP + MPIN login as the
  // owner, so each one has a record here with role EMP. The Employee document
  // stays the source of truth for name, designation, permissions and
  // isActive; this links back to it. Never set on an owner's record.
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    index: true,
    sparse: true
  },
  // A copy of the employee's permissions, refreshed whenever the owner edits
  // them. Access checks still read the Employee document; this is the mirror
  // the user record carries. Absent on owners, who can do everything.
  permissions: {
    type: Map,
    of: Boolean,
    default: undefined
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

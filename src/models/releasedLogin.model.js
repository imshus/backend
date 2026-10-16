const mongoose = require('mongoose');

/**
 * A sign-in record taken out of business_users so its number could become
 * another shop's employee (or this shop's, when it was a second owner here),
 * kept whole so it can be put back (scripts/restore_released_login.js).
 *
 * Only the sign-in record moves. The shop it belonged to — its business,
 * invoices, scans, wallet and licence — is never touched; until it is given
 * an owner again, nobody signs in to it. For another shop's employee the
 * Employee document stays where it is, switched off, and `previousIsActive`
 * says what it was before.
 */
const releasedLoginSchema = new mongoose.Schema({
  // The ten digits the record held, and that the new employee took.
  phone: {
    type: String,
    required: true,
    index: true
  },
  reason: {
    type: String,
    enum: ['MADE_EMPLOYEE'],
    default: 'MADE_EMPLOYEE',
    required: true
  },
  // 'owner' for an OWNER record, 'employee' for another shop's employee.
  kind: {
    type: String,
    enum: ['owner', 'employee'],
    required: true
  },
  // The shop the record (or the employee) belonged to.
  fromBusinessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    default: null
  },
  // The business_users document exactly as it was, every field included
  // (hashes and the sealed MPIN too, so a restore signs in as before). Null
  // for an employee from before sign-in records, who had none.
  original: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  // Another shop's employee switched off by the move, and what isActive was.
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    default: null
  },
  previousIsActive: {
    type: Boolean,
    default: null
  },
  releasedAt: {
    type: Date,
    default: Date.now
  },
  // The shop and the owner whose new employee took the number.
  releasedByBusinessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  releasedByUserId: {
    type: String,
    default: ''
  },
  // Set once the record is back in business_users.
  restoredAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  // `original` is kept exactly as it was, empty objects included.
  minimize: false,
  collection: 'released_logins'
});

module.exports = mongoose.model('ReleasedLogin', releasedLoginSchema);

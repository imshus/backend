const mongoose = require('mongoose');

/**
 * A sign-in record taken out of business_users, kept whole so it can be put
 * back (scripts/restore_released_login.js). `reason` says why:
 *   - MADE_EMPLOYEE    its number became another shop's employee (or this
 *                      shop's, when it was a second owner here);
 *   - ACCOUNT_DELETED  its holder deleted their own account (DELETE
 *                      /auth/account, accountRelease.service).
 *
 * Only the sign-in record moves. The shop it belonged to — its business,
 * invoices, scans, wallet and licence — is never touched; until it is given
 * an owner again, nobody signs in to it. For an employee the Employee
 * document stays where it is, switched off, and `previousIsActive` says what
 * it was before.
 */
const releasedLoginSchema = new mongoose.Schema({
  // The ten digits the record held (for MADE_EMPLOYEE, the ones the new
  // employee took).
  phone: {
    type: String,
    required: true,
    index: true
  },
  reason: {
    type: String,
    enum: ['MADE_EMPLOYEE', 'ACCOUNT_DELETED'],
    default: 'MADE_EMPLOYEE',
    required: true
  },
  // 'owner' for an OWNER (or SUPER) record, 'employee' for an employee.
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
  // The employee switched off by the release, and what isActive was.
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
  // The shop and the owner whose new employee took the number; for
  // ACCOUNT_DELETED, the holder's own shop and id (an employee's is their
  // Employee document's, as their token carries it).
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

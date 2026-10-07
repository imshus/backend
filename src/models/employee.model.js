const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  // Ten digits. Indexed because adding an employee checks the number against
  // every shop's active employees, not just this one's.
  phone: {
    type: String,
    trim: true,
    index: true
  },
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  // What this person does, as typed on Add New Employee ("Sales", "Karigar").
  // Blank on employees added before it was stored; the roster then reads
  // "Employee" for them.
  designation: {
    type: String,
    default: '',
    trim: true
  },
  // The credential of the old employee login (POST /auth/employee/login),
  // still honoured for app builds that create employees with a password. An
  // employee added with an MPIN has none: the MPIN lives, hashed and sealed,
  // on their sign-in record in business_users.
  passwordHash: {
    type: String
  },
  // That sign-in record (role EMP): phone, MPIN and the shop's GST details.
  businessUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BusinessUser',
    default: null
  },
  permissions: {
    type: Map,
    of: Boolean,
    default: {}
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLoginAt: {
    type: Date
  }
}, {
  timestamps: true,
  collection: 'employees'
});

module.exports = mongoose.model('Employee', employeeSchema);

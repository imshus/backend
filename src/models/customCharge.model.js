const mongoose = require('mongoose');

const customChargeSchema = new mongoose.Schema(
  {
    // The shop's names carry no userId; an employee who changes the list gets
    // their own private copy of it under theirs.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

customChargeSchema.index({ businessId: 1, userId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('CustomCharge', customChargeSchema);

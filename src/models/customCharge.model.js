const mongoose = require('mongoose');

const customChargeSchema = new mongoose.Schema(
  {
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

customChargeSchema.index({ businessId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('CustomCharge', customChargeSchema);

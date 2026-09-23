const mongoose = require('mongoose');

/**
 * The wastage catalogue, managed from Masters → Wastage: a short code the
 * shop uses for a kind of making, and the wastage percentage that goes with
 * it. Each user keeps their own list, the owner's being the shop's — the same
 * arrangement as the item codes.
 */
const wastageCodeSchema = new mongoose.Schema(
  {
    // The shop's codes carry no userId; an employee who changes the list gets
    // their own private copy of it under their userId.
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
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
    },
    // Null means the shop has not given a figure, which is not the same as
    // zero wastage.
    percent: {
      type: Number,
      default: null,
      min: 0,
      max: 100,
    },
  },
  {
    timestamps: true,
    collection: 'wastage_codes',
  },
);

wastageCodeSchema.index({ businessId: 1, userId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('WastageCode', wastageCodeSchema);

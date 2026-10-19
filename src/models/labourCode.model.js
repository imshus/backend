const mongoose = require('mongoose');

/**
 * The labour catalogue, managed from Masters → Labour Code: a short code the
 * shop uses for a kind of making (LB-01, LB-02 …) and the labour charged for
 * it, rupees per gram, per 10 g, or a percent of the gold value. Each user
 * keeps their own list, the owner's being the shop's — the same arrangement
 * as the wastage codes and the item codes.
 */
const labourCodeSchema = new mongoose.Schema(
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
      maxlength: 20,
    },
    // Every save must give one (labourCode.controller refuses a blank rate).
    // Null only on a row kept from before that, which is not the same as no
    // labour: it prices as if no code were picked, and the card does not
    // offer it. Not `required` here, so an employee's copy of a shop list
    // holding such a row still saves.
    rate: {
      type: Number,
      default: null,
      min: 0,
    },
    unit: {
      type: String,
      enum: ['Per Gram', 'Per 10 Gram', 'Percent'],
      default: 'Per Gram',
    },
  },
  {
    timestamps: true,
    collection: 'labour_codes',
  },
);

labourCodeSchema.index({ businessId: 1, userId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('LabourCode', labourCodeSchema);

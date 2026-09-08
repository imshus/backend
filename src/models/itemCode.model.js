const mongoose = require('mongoose');

/**
 * The shop's item-code catalogue, managed from Masters → Item Code. One code
 * per business, uppercase, with an optional free-text description.
 */
const itemCodeSchema = new mongoose.Schema(
  {
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
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 200,
    },
  },
  {
    timestamps: true,
    collection: 'item_codes',
  },
);

itemCodeSchema.index({ businessId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('ItemCode', itemCodeSchema);

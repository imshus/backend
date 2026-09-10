const mongoose = require('mongoose');

/**
 * The item-code catalogue, managed from Masters → Item Code. One code per
 * list, uppercase, with an optional free-text description; each user keeps
 * their own list, the owner's being the shop's.
 */
const itemCodeSchema = new mongoose.Schema(
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

itemCodeSchema.index({ businessId: 1, userId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('ItemCode', itemCodeSchema);

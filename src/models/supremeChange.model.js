const mongoose = require('mongoose');

const supremeChangeSchema = new mongoose.Schema({
  rtgsChange: {
    type: Number,
    default: 0
  },
  cashChange: {
    type: Number,
    default: 0
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BusinessUser'
  }
}, {
  timestamps: true,
  collection: 'supreme_changes'
});

module.exports = mongoose.model('SupremeChange', supremeChangeSchema);

const mongoose = require('mongoose');

const mcxFetchSchema = new mongoose.Schema({
  lastFetchedTime: {
    type: Date,
    required: true,
  },
  expectedNextFetchTime: {
    type: Date,
    required: true,
  },
  numberOfApiCall: {
    type: Number,
    required: true,
    default: 0,
  }
}, { timestamps: true });

const MCXFetch = mongoose.model('MCXFetch', mcxFetchSchema);

module.exports = MCXFetch;

const mongoose = require('mongoose');

/**
 * Which rate rows the home screen shows. One record per business (the
 * owner's, with no userId — the shop's default) plus one per employee who
 * has saved their own.
 */
const dashboardMetricsSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  userId: {
    type: String,
    default: null,
    index: true
  },
  metricsData: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true,
  collection: 'dashboard_metrics'
});

dashboardMetricsSchema.index({ businessId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('DashboardMetrics', dashboardMetricsSchema);

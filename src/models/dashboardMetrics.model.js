const mongoose = require('mongoose');

const dashboardMetricsSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    unique: true
  },
  metricsData: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true,
  collection: 'dashboard_metrics'
});

module.exports = mongoose.model('DashboardMetrics', dashboardMetricsSchema);

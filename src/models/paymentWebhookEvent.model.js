const mongoose = require('mongoose');

const paymentWebhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    orderId: {
      type: String,
      default: null,
      index: true,
    },
    paymentId: {
      type: String,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ['RECEIVED', 'VERIFIED', 'PROCESSED', 'IGNORED', 'FAILED'],
      default: 'RECEIVED',
      index: true,
    },
    payloadHash: {
      type: String,
      required: true,
      index: true,
    },
    signature: {
      type: String,
      default: '',
    },
    failureReason: {
      type: String,
      default: '',
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'payment_webhook_events',
  }
);

module.exports = mongoose.model('PaymentWebhookEvent', paymentWebhookEventSchema);

const crypto = require('crypto');

const PaymentWebhookEvent = require('../models/paymentWebhookEvent.model');
const razorpayService = require('./razorpay.service');
const billingConfigService = require('./billingConfig.service');
const paymentService = require('./payment.service');

function hashPayload(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function handleRazorpayWebhook({ rawBody, parsedBody, headers }) {
  const eventId = String(headers['x-razorpay-event-id'] || '').trim();
  const signature = String(headers['x-razorpay-signature'] || '').trim();
  const eventType = String(parsedBody?.event || 'unknown');
  const payloadHash = hashPayload(rawBody);

  if (!eventId) {
    throw new Error('WEBHOOK_EVENT_ID_MISSING');
  }

  const existing = await PaymentWebhookEvent.findOne({ eventId });
  if (existing) {
    return { duplicate: true, eventId, status: existing.status };
  }

  const webhookRow = await PaymentWebhookEvent.create({
    eventId,
    eventType,
    payloadHash,
    signature,
    status: 'RECEIVED',
    payload: parsedBody,
  });

  console.info('[WEBHOOK_RECEIVED]', {
    eventId,
    eventType,
  });

  const cfg = await billingConfigService.getEffectiveConfig();
  const verified = razorpayService.verifyWebhookSignature({
    rawBody,
    signature,
    webhookSecret: cfg.webhookSecret,
  });

  if (!verified) {
    webhookRow.status = 'FAILED';
    webhookRow.failureReason = 'Signature verification failed';
    webhookRow.processedAt = new Date();
    await webhookRow.save();

    console.warn('[WEBHOOK_SIGNATURE_FAILED]', { eventId, eventType });
    throw new Error('INVALID_WEBHOOK_SIGNATURE');
  }

  webhookRow.status = 'VERIFIED';
  await webhookRow.save();

  console.info('[WEBHOOK_VERIFIED]', { eventId, eventType });

  const entity = parsedBody?.payload?.payment?.entity || parsedBody?.payload?.refund?.entity || {};
  const orderId = entity.order_id || null;
  const paymentId = entity.id || entity.payment_id || null;

  webhookRow.orderId = orderId;
  webhookRow.paymentId = paymentId;

  try {
    if (eventType === 'payment.captured') {
      await paymentService.processPaymentCapturedWebhook({
        orderId,
        paymentId,
        paymentPayload: entity,
        gatewaySignature: signature,
      });
    } else if (eventType === 'payment.failed') {
      await paymentService.processPaymentFailedWebhook({
        orderId,
        paymentId,
        failureReason: entity.error_description || entity.error_reason || 'Payment failed',
        paymentPayload: entity,
      });
    } else if (eventType === 'refund.processed' || eventType === 'payment.refunded') {
      await paymentService.processRefundWebhook({
        orderId,
        paymentId,
        refundPayload: entity,
      });
    }

    webhookRow.status = 'PROCESSED';
    webhookRow.processedAt = new Date();
    await webhookRow.save();

    return { duplicate: false, eventId, status: 'PROCESSED' };
  } catch (error) {
    webhookRow.status = 'FAILED';
    webhookRow.failureReason = error.message || 'Webhook processing failed';
    webhookRow.processedAt = new Date();
    await webhookRow.save();
    throw error;
  }
}

module.exports = {
  handleRazorpayWebhook,
};

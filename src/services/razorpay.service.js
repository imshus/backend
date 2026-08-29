const crypto = require('crypto');
const Razorpay = require('razorpay');
const config = require('../config/env');

let client = null;

function getClient() {
  if (client) {
    return client;
  }

  if (!config.razorpay.keyId || !config.razorpay.keySecret) {
    throw new Error('RAZORPAY_CONFIG_MISSING');
  }

  client = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });

  return client;
}

async function createOrder({ amountInPaise, receipt, notes = {}, currency = 'INR' }) {
  const razorpay = getClient();
  const order = await razorpay.orders.create({
    amount: amountInPaise,
    currency,
    receipt,
    notes,
    payment_capture: 1,
  });
  return order;
}

function verifyPaymentSignature({ orderId, paymentId, signature }) {
  const payload = `${orderId}|${paymentId}`;
  const expectedSignature = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(payload)
    .digest('hex');

  return expectedSignature === signature;
}

function verifyWebhookSignature({ rawBody, signature, webhookSecret }) {
  const secret = webhookSecret || config.razorpay.webhookSecret || config.razorpay.keySecret;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return expectedSignature === signature;
}

async function fetchPayment(paymentId) {
  const razorpay = getClient();
  return razorpay.payments.fetch(paymentId);
}

module.exports = {
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchPayment,
};

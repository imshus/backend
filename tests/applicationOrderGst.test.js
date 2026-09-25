/**
 * The licence is charged at its price plus 18% GST: 12,000 + 2,160 = 14,160.
 * The order, the stored payment row and the checkout amount agree to the
 * paisa, and the GST split is recorded. Credit recharges are untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const paymentService = require('../src/services/payment.service');
const PaymentTransaction = require('../src/models/paymentTransaction.model');
const razorpayService = require('../src/services/razorpay.service');
const billingConfigService = require('../src/services/billingConfig.service');
const licenseService = require('../src/services/license.service');

const original = {
  create: PaymentTransaction.create,
  findOne: PaymentTransaction.findOne,
  createOrder: razorpayService.createOrder,
  verifyPaymentSignature: razorpayService.verifyPaymentSignature,
  fetchPayment: razorpayService.fetchPayment,
  getEffectiveConfig: billingConfigService.getEffectiveConfig,
  getLicenseOverview: licenseService.getLicenseOverview,
};

test.after(() => {
  PaymentTransaction.create = original.create;
  PaymentTransaction.findOne = original.findOne;
  razorpayService.createOrder = original.createOrder;
  razorpayService.verifyPaymentSignature = original.verifyPaymentSignature;
  razorpayService.fetchPayment = original.fetchPayment;
  billingConfigService.getEffectiveConfig = original.getEffectiveConfig;
  licenseService.getLicenseOverview = original.getLicenseOverview;
});

/** Stubs every dependency of the licence order; returns what they received. */
function stubOrder({ applicationPrice, licenseStatus = 'FREE_TRIAL_LICENSE' }) {
  const seen = { orders: [], rows: [] };
  billingConfigService.getEffectiveConfig = async () => ({ applicationPrice });
  licenseService.getLicenseOverview = async () => ({ licenseStatus });
  razorpayService.createOrder = async (args) => {
    seen.orders.push(args);
    return { id: 'order_t', currency: 'INR' };
  };
  PaymentTransaction.create = async (doc) => {
    seen.rows.push(doc);
    return doc;
  };
  return seen;
}

const order = (price) => {
  const seen = stubOrder({ applicationPrice: price });
  return paymentService
    .createOrderForApplicationPurchase({ businessId: '507f1f77bcf86cd799439011', userId: 'u1' })
    .then((result) => ({ result, seen }));
};

test('a 12,000 licence is charged 14,160: 12,000 plus 18% GST', async () => {
  const { result, seen } = await order(12000);

  assert.equal(seen.orders.length, 1);
  assert.equal(seen.orders[0].amountInPaise, 1416000);
  assert.equal(seen.orders[0].notes.baseAmount, '12000');
  assert.equal(seen.orders[0].notes.gstAmount, '2160');
  assert.equal(seen.orders[0].notes.gstPercent, '18');

  const row = seen.rows[0];
  assert.equal(row.amount, 14160);
  assert.equal(row.baseAmount, 12000);
  assert.equal(row.gstAmount, 2160);
  assert.equal(row.amountInPaise, 1416000);

  // Checkout opens on exactly what the order and the row say.
  assert.equal(result.amountInPaise, 1416000);
  assert.equal(result.amount, 14160);
  assert.equal(result.baseAmount, 12000);
  assert.equal(result.gstAmount, 2160);
  assert.equal(result.gstPercent, 18);
});

test('base + GST equals the charge to the paisa for awkward prices', async () => {
  for (const price of [9999, 12345.67, 1000.08, 1024.09, 1, 0.5]) {
    const { result, seen } = await order(price);
    const basePaise = Math.round(price * 100);
    const gstPaise = Math.round((basePaise * 18) / 100);
    assert.equal(result.amountInPaise, basePaise + gstPaise, `price ${price}`);
    assert.equal(seen.orders[0].amountInPaise, result.amountInPaise, `price ${price}`);
    assert.equal(seen.rows[0].amountInPaise, result.amountInPaise, `price ${price}`);
    assert.equal(Math.round(result.amount * 100), result.amountInPaise, `price ${price}`);
    assert.equal(
      Math.round(result.baseAmount * 100) + Math.round(result.gstAmount * 100),
      result.amountInPaise,
      `price ${price}`,
    );
  }
});

test('a missing or broken price refuses the order before Razorpay is asked', async () => {
  for (const price of [0, undefined, 'abc', -5]) {
    const seen = stubOrder({ applicationPrice: price });
    await assert.rejects(
      paymentService.createOrderForApplicationPurchase({ businessId: 'b', userId: 'u' }),
      /INVALID_APPLICATION_PRICE/,
      `price ${String(price)}`,
    );
    assert.equal(seen.orders.length, 0);
    assert.equal(seen.rows.length, 0);
  }
});

test('a licence already bought is not charged again', async () => {
  const seen = stubOrder({ applicationPrice: 12000, licenseStatus: 'PERMANENT_LICENSE' });
  await assert.rejects(
    paymentService.createOrderForApplicationPurchase({ businessId: 'b', userId: 'u' }),
    /APPLICATION_ALREADY_PURCHASED/,
  );
  assert.equal(seen.orders.length, 0);
});

test('a payment of the old 12,000 against a 14,160 order is refused', async () => {
  const txn = {
    orderId: 'order-gst',
    amountInPaise: 1416000,
    verificationAttempts: 0,
    status: 'ORDER_CREATED',
    gatewayResponse: {},
    async save() { return this; },
  };
  PaymentTransaction.findOne = async () => txn;
  razorpayService.verifyPaymentSignature = () => true;
  razorpayService.fetchPayment = async () => ({
    id: 'pay-short', order_id: 'order-gst', amount: 1200000, status: 'captured',
  });

  await assert.rejects(
    paymentService.verifyPaymentAndApply({
      businessId: 'b', userId: 'u', orderId: 'order-gst', paymentId: 'pay-short', signature: 's',
    }),
    /PAYMENT_AMOUNT_MISMATCH/,
  );
  assert.equal(txn.status, 'VERIFICATION_FAILED');
});

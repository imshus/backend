/**
 * iPhone In-App Purchase: a StoreKit 2 transaction is checked against
 * Apple's root certificate, then applied once through the same effects as a
 * Razorpay payment. A forged JWS is refused, a pack adds its credits at the
 * Android price + GST, a replay is not applied twice, a licence restore finds
 * its original order, and one shop cannot use another shop's purchase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const appleIap = require('../src/services/appleIap.service');
const paymentService = require('../src/services/payment.service');
const PaymentTransaction = require('../src/models/paymentTransaction.model');
const billingConfigService = require('../src/services/billingConfig.service');

const original = {
  create: PaymentTransaction.create,
  findOne: PaymentTransaction.findOne,
  applyPaymentEffects: paymentService.applyPaymentEffects,
  getEffectiveConfig: billingConfigService.getEffectiveConfig,
};

test.after(() => {
  PaymentTransaction.create = original.create;
  PaymentTransaction.findOne = original.findOne;
  paymentService.applyPaymentEffects = original.applyPaymentEffects;
  billingConfigService.getEffectiveConfig = original.getEffectiveConfig;
  appleIap._setVerifiersForTest(null);
});

const SHOP = '507f1f77bcf86cd799439011';
const OTHER_SHOP = '507f1f77bcf86cd799439022';

const decodingTo = (payload) => [{ verifyAndDecodeTransaction: async () => payload }];

/** An in-memory payments table and a verifier that decodes to `payload`. */
function stub(payload) {
  const rows = [];
  const applied = [];
  appleIap._setVerifiersForTest(decodingTo(payload));
  billingConfigService.getEffectiveConfig = async () => ({ applicationPrice: 12000 });
  PaymentTransaction.findOne = async (query) => rows.find((row) => row.orderId === query.orderId) || null;
  PaymentTransaction.create = async (doc) => {
    if (rows.some((row) => row.orderId === doc.orderId)) throw Object.assign(new Error('dup'), { code: 11000 });
    rows.push(doc);
    return doc;
  };
  paymentService.applyPaymentEffects = async ({ txn, source }) => {
    const idempotent = txn.status === 'PAYMENT_SUCCESS';
    if (!idempotent) {
      applied.push({ orderId: txn.orderId, source });
      txn.status = 'PAYMENT_SUCCESS';
    }
    return { txn, wallet: { creditBalance: 0 }, idempotent };
  };
  return { rows, applied };
}

const apply = (businessId = SHOP) =>
  appleIap.verifyAndApplyTransaction({ businessId, userId: 'u1', signedTransaction: 'jws' });

test('a JWS not signed by Apple is refused', async () => {
  appleIap._setVerifiersForTest(null);
  const forged = [
    Buffer.from(JSON.stringify({ alg: 'ES256', x5c: ['AAAA', 'BBBB', 'CCCC'] })).toString('base64url'),
    Buffer.from(JSON.stringify({ productId: 'com.amitaashitsolution.credits500', transactionId: '1' })).toString('base64url'),
    'c2lnbmF0dXJl',
  ].join('.');
  await assert.rejects(
    appleIap.verifyAndApplyTransaction({ businessId: SHOP, userId: 'u1', signedTransaction: forged }),
    { message: 'APPLE_TRANSACTION_INVALID' },
  );
});

test('a missing transaction is refused before any check', async () => {
  await assert.rejects(
    appleIap.verifyAndApplyTransaction({ businessId: SHOP, userId: 'u1', signedTransaction: '' }),
    { message: 'APPLE_TRANSACTION_MISSING' },
  );
});

test('a credit pack adds its credits, priced as Android (credits + 18% GST)', async () => {
  const { rows, applied } = stub({
    productId: 'com.amitaashitsolution.credits250', transactionId: '2000001', originalTransactionId: '2000001', environment: 'Sandbox',
  });
  await apply();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'APPLE');
  assert.equal(rows[0].paymentType, 'CREDIT_RECHARGE');
  assert.equal(rows[0].creditsPurchased, 250);
  assert.equal(rows[0].amount, 295);
  assert.equal(rows[0].gstAmount, 45);
  assert.equal(rows[0].orderId, 'apple-2000001');
  assert.deepEqual(applied, [{ orderId: 'apple-2000001', source: 'APPLE_IAP' }]);
});

test('the same transaction sent again is not applied twice', async () => {
  const { rows, applied } = stub({
    productId: 'com.amitaashitsolution.credits50', transactionId: '2000002', originalTransactionId: '2000002',
  });
  const first = await apply();
  const again = await apply();
  assert.equal(first.idempotent, false);
  assert.equal(again.idempotent, true);
  assert.equal(rows.length, 1);
  assert.equal(applied.length, 1);
});

test('the licence is keyed by its original transaction, so a restore finds it', async () => {
  const { rows, applied } = stub({
    productId: 'com.amitaashitsolution.licence', transactionId: '3000001', originalTransactionId: '3000001',
  });
  await apply();
  assert.equal(rows[0].amount, 14160);
  assert.equal(rows[0].paymentType, 'APPLICATION_PURCHASE');
  appleIap._setVerifiersForTest(decodingTo({
    productId: 'com.amitaashitsolution.licence', transactionId: '3000099', originalTransactionId: '3000001',
  }));
  const restored = await apply();
  assert.equal(restored.idempotent, true);
  assert.equal(rows.length, 1);
  assert.equal(applied.length, 1);
});

test('another shop cannot use a purchase already applied to a shop', async () => {
  stub({ productId: 'com.amitaashitsolution.licence', transactionId: '4000001', originalTransactionId: '4000001' });
  await apply(SHOP);
  await assert.rejects(apply(OTHER_SHOP), { message: 'APPLE_PURCHASE_OTHER_ACCOUNT' });
});

test('an unknown product or a refunded transaction grants nothing', async () => {
  const { rows } = stub({ productId: 'com.someone.else', transactionId: '5' });
  await assert.rejects(apply(), { message: 'APPLE_PRODUCT_UNKNOWN' });
  appleIap._setVerifiersForTest(decodingTo({
    productId: 'com.amitaashitsolution.credits100', transactionId: '6', revocationDate: 1,
  }));
  await assert.rejects(apply(), { message: 'APPLE_TRANSACTION_REVOKED' });
  assert.equal(rows.length, 0);
});

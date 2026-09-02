const test = require('node:test');
const assert = require('node:assert/strict');

const paymentService = require('../src/services/payment.service');
const PaymentTransaction = require('../src/models/paymentTransaction.model');
const razorpayService = require('../src/services/razorpay.service');
const walletService = require('../src/services/wallet.service');

const originalFindOne = PaymentTransaction.findOne;
const originalVerifyPaymentSignature = razorpayService.verifyPaymentSignature;
const originalFetchPayment = razorpayService.fetchPayment;
const originalEnsureWallet = walletService.ensureWallet;

test.after(() => {
  PaymentTransaction.findOne = originalFindOne;
  razorpayService.verifyPaymentSignature = originalVerifyPaymentSignature;
  razorpayService.fetchPayment = originalFetchPayment;
  walletService.ensureWallet = originalEnsureWallet;
});

test('authorized Razorpay payment stays pending and does not update the wallet', async () => {
  let saveCount = 0;
  let walletRead = false;
  const txn = {
    orderId: 'order-authorized',
    amountInPaise: 50000,
    verificationAttempts: 0,
    status: 'ORDER_CREATED',
    gatewayResponse: {},
    async save() {
      saveCount += 1;
      return this;
    },
  };

  PaymentTransaction.findOne = async () => txn;
  razorpayService.verifyPaymentSignature = () => true;
  razorpayService.fetchPayment = async () => ({
    id: 'pay-authorized',
    order_id: 'order-authorized',
    amount: 50000,
    status: 'authorized',
  });
  walletService.ensureWallet = async () => {
    walletRead = true;
    return { creditBalance: 500 };
  };

  await assert.rejects(
    paymentService.verifyPaymentAndApply({
      businessId: 'business-1',
      userId: 'user-1',
      orderId: 'order-authorized',
      paymentId: 'pay-authorized',
      signature: 'valid-signature',
    }),
    /PAYMENT_NOT_CAPTURED/,
  );

  assert.equal(txn.status, 'PAYMENT_PENDING');
  assert.equal(txn.paymentId, 'pay-authorized');
  assert.equal(txn.walletCredited, undefined);
  assert.equal(walletRead, false);
  assert.equal(saveCount, 1);
});

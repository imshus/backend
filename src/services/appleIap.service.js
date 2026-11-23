const fs = require('node:fs');
const path = require('node:path');
const {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} = require('@apple/app-store-server-library');

const PaymentTransaction = require('../models/paymentTransaction.model');
const billingConfigService = require('./billingConfig.service');
const paymentService = require('./payment.service');

/**
 * Apple In-App Purchase on the iPhone app (Nov 2026). The app buys with
 * StoreKit 2 and sends the transaction Apple signed (a JWS); it is checked
 * here against Apple's root certificate before anything is granted, then
 * goes through the same applyPaymentEffects as a Razorpay payment: the
 * licence with its bonus credits, or the credits of the pack.
 *
 * Prices match Android (the owner's choice): the licence at the licence
 * price + 18% GST, credits + 18% GST. Apple charges the shop and keeps its
 * commission; the amounts stored are the list price, for history and stats.
 *
 * The product ids must match the products created in App Store Connect.
 */
const PRODUCTS = {
  'com.amitaashitsolution.licence': { paymentType: 'APPLICATION_PURCHASE' },
  'com.amitaashitsolution.credits50': { paymentType: 'CREDIT_RECHARGE', credits: 50 },
  'com.amitaashitsolution.credits100': { paymentType: 'CREDIT_RECHARGE', credits: 100 },
  'com.amitaashitsolution.credits250': { paymentType: 'CREDIT_RECHARGE', credits: 250 },
  'com.amitaashitsolution.credits500': { paymentType: 'CREDIT_RECHARGE', credits: 500 },
};

const BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.amitaashitsolution';
const APP_APPLE_ID = Number(process.env.APPLE_APP_ID || 6814716647);
// App Review and TestFlight buy in Apple's sandbox against this same server,
// so sandbox purchases are accepted unless turned off.
const ALLOW_SANDBOX = !/^(0|false|no)$/i.test(String(process.env.APPLE_IAP_ALLOW_SANDBOX || 'true'));

let verifiers = null;

function getVerifiers() {
  if (verifiers) return verifiers;
  const roots = [fs.readFileSync(path.join(__dirname, '..', '..', 'certs', 'apple', 'AppleRootCA-G3.cer'))];
  verifiers = [new SignedDataVerifier(roots, false, Environment.PRODUCTION, BUNDLE_ID, APP_APPLE_ID)];
  if (ALLOW_SANDBOX) verifiers.push(new SignedDataVerifier(roots, false, Environment.SANDBOX, BUNDLE_ID));
  return verifiers;
}

/**
 * Runs one of the verifier's decode calls, production first, then sandbox
 * when the JWS says it came from there. Coded errors for everything else.
 */
async function decodeSigned(call) {
  let lastError = null;
  for (const verifier of getVerifiers()) {
    try {
      return await call(verifier);
    } catch (error) {
      lastError = error;
      if (error instanceof VerificationException && error.status === VerificationStatus.INVALID_ENVIRONMENT) continue;
      break;
    }
  }
  if (lastError instanceof VerificationException
    && lastError.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
    throw new Error('APPLE_VERIFICATION_RETRY');
  }
  console.warn('[APPLE_IAP_VERIFY_FAILED]', {
    status: lastError?.status,
    detail: String(lastError?.message || lastError).slice(0, 200),
  });
  throw new Error('APPLE_TRANSACTION_INVALID');
}

function decodeTransaction(signedTransaction) {
  return decodeSigned((verifier) => verifier.verifyAndDecodeTransaction(signedTransaction));
}

/**
 * One order per purchase. The licence is keyed by its original transaction,
 * so a restore (the same purchase handed back on a new phone) finds the order
 * already applied instead of making a second one.
 */
function orderIdFor(product, transaction) {
  if (product.paymentType === 'APPLICATION_PURCHASE') {
    return `apple-${transaction.originalTransactionId || transaction.transactionId}`;
  }
  return `apple-${transaction.transactionId}`;
}

function withGst(basePaise, percent) {
  const gstPaise = Math.round((basePaise * percent) / 100);
  return {
    baseAmount: basePaise / 100,
    gstAmount: gstPaise / 100,
    amount: (basePaise + gstPaise) / 100,
    amountInPaise: basePaise + gstPaise,
  };
}

async function listPrice(product) {
  if (product.paymentType === 'APPLICATION_PURCHASE') {
    const cfg = await billingConfigService.getEffectiveConfig();
    return withGst(Math.round(Number(cfg.applicationPrice || 12000) * 100), paymentService.APPLICATION_GST_PERCENT);
  }
  return withGst(Math.round(product.credits * 100), paymentService.CREDIT_GST_PERCENT);
}

function appleSummary(transaction) {
  return {
    transactionId: transaction.transactionId,
    originalTransactionId: transaction.originalTransactionId,
    productId: transaction.productId,
    environment: transaction.environment,
    storefront: transaction.storefront,
    price: transaction.price,
    currency: transaction.currency,
    purchaseDate: transaction.purchaseDate,
  };
}

/**
 * Verifies a StoreKit 2 transaction from the app and grants what it bought
 * to the shop's account. Safe to call again with the same transaction (the
 * app retries until the server answers, and replays unfinished ones).
 */
async function verifyAndApplyTransaction({ businessId, userId, signedTransaction }) {
  if (typeof signedTransaction !== 'string' || !signedTransaction.trim()) {
    throw new Error('APPLE_TRANSACTION_MISSING');
  }
  const transaction = await decodeTransaction(signedTransaction.trim());
  const product = PRODUCTS[transaction.productId];
  if (!product) throw new Error('APPLE_PRODUCT_UNKNOWN');
  if (transaction.revocationDate) throw new Error('APPLE_TRANSACTION_REVOKED');

  const orderId = orderIdFor(product, transaction);
  let txn = await PaymentTransaction.findOne({ orderId });

  if (!txn) {
    const price = await listPrice(product);
    try {
      txn = await PaymentTransaction.create({
        businessId,
        initiatedByUserId: userId,
        provider: 'APPLE',
        paymentType: product.paymentType,
        orderId,
        receipt: orderId,
        paymentId: `apple-txn-${transaction.transactionId}`,
        ...price,
        creditsPurchased: product.credits || 0,
        currency: 'INR',
        status: 'PAYMENT_PENDING',
        idempotencyKey: `${orderId}:${product.paymentType}`,
        gatewayResponse: { apple: appleSummary(transaction) },
      });
    } catch (error) {
      // The same purchase sent twice at once: the other request made it.
      if (error?.code !== 11000) throw error;
      txn = await PaymentTransaction.findOne({ orderId });
      if (!txn) throw error;
    }
  }

  if (String(txn.businessId) !== String(businessId)) {
    throw new Error('APPLE_PURCHASE_OTHER_ACCOUNT');
  }

  console.info('[APPLE_IAP_VERIFIED]', {
    businessId: String(businessId),
    orderId,
    productId: transaction.productId,
    environment: transaction.environment,
  });

  return paymentService.applyPaymentEffects({
    txn,
    source: 'APPLE_IAP',
    paymentPayload: { apple: appleSummary(transaction) },
  });
}

/**
 * App Store Server Notifications V2: a refund or revocation marks the order
 * refunded, as a Razorpay refund does. Everything else is acknowledged.
 */
async function handleServerNotification(signedPayload) {
  if (typeof signedPayload !== 'string' || !signedPayload.trim()) {
    throw new Error('APPLE_TRANSACTION_MISSING');
  }
  const notification = await decodeSigned((verifier) => verifier.verifyAndDecodeNotification(signedPayload.trim()));
  const type = notification.notificationType;
  if (type !== 'REFUND' && type !== 'REVOKE') return { ignored: true, reason: type };

  const signedTransaction = notification.data?.signedTransactionInfo;
  if (!signedTransaction) return { ignored: true, reason: 'NO_TRANSACTION' };
  const transaction = await decodeTransaction(signedTransaction);
  const product = PRODUCTS[transaction.productId];
  if (!product) return { ignored: true, reason: 'UNKNOWN_PRODUCT' };

  return paymentService.processRefundWebhook({
    orderId: orderIdFor(product, transaction),
    paymentId: `apple-txn-${transaction.transactionId}`,
    refundPayload: { apple: { ...appleSummary(transaction), notificationType: type, revocationReason: transaction.revocationReason } },
  });
}

module.exports = {
  PRODUCTS,
  /** Tests only: stand-in verifiers (objects with the verifier's decode calls). */
  _setVerifiersForTest(next) {
    verifiers = next;
  },
  verifyAndApplyTransaction,
  handleServerNotification,
};

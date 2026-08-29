const mongoose = require('mongoose');

const Business = require('../models/business.model');
const LicenseTransaction = require('../models/licenseTransaction.model');
const PaymentTransaction = require('../models/paymentTransaction.model');
const CreditTransaction = require('../models/creditTransaction.model');
const licenseService = require('./license.service');
const walletService = require('./wallet.service');
const creditService = require('./credit.service');
const billingConfigService = require('./billingConfig.service');
const razorpayService = require('./razorpay.service');
const { getStatsKeys } = require('./statistics.service');
const config = require('../config/env');

function toTwo(value) {
  return Number(Number(value || 0).toFixed(2));
}

function toPaise(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function buildReceipt(paymentType, businessId) {
  const suffix = Date.now();
  const bid = String(businessId).slice(-6);
  if (paymentType === 'APPLICATION_PURCHASE') {
    return `app-${bid}-${suffix}`;
  }
  return `cred-${bid}-${suffix}`;
}

function buildInvoiceNumber() {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const random = Math.floor(100000 + Math.random() * 900000);
  return `INV-${yy}${mm}${dd}-${random}`;
}

async function createOrderForApplicationPurchase({ businessId, userId }) {
  const cfg = await billingConfigService.getEffectiveConfig();
  const { licenseStatus } = await licenseService.getLicenseOverview(businessId);

  if (licenseStatus === 'PERMANENT_LICENSE') {
    throw new Error('APPLICATION_ALREADY_PURCHASED');
  }

  const amount = toTwo(cfg.applicationPrice);
  if (amount <= 0) {
    throw new Error('INVALID_APPLICATION_PRICE');
  }

  const receipt = buildReceipt('APPLICATION_PURCHASE', businessId);

  console.info('[PAYMENT_INITIATED]', {
    businessId: String(businessId),
    userId: String(userId),
    paymentType: 'APPLICATION_PURCHASE',
    amount,
  });

  const order = await razorpayService.createOrder({
    amountInPaise: toPaise(amount),
    receipt,
    notes: {
      paymentType: 'APPLICATION_PURCHASE',
      businessId: String(businessId),
      initiatedByUserId: String(userId),
    },
  });

  console.info('[ORDER_CREATED]', {
    businessId: String(businessId),
    userId: String(userId),
    paymentType: 'APPLICATION_PURCHASE',
    orderId: order.id,
    amount,
  });

  await PaymentTransaction.create({
    businessId,
    initiatedByUserId: userId,
    paymentType: 'APPLICATION_PURCHASE',
    orderId: order.id,
    receipt,
    amount,
    baseAmount: amount,
    gstAmount: 0,
    amountInPaise: toPaise(amount),
    currency: order.currency || 'INR',
    status: 'ORDER_CREATED',
    idempotencyKey: `${order.id}:APPLICATION_PURCHASE`,
  });

  return {
    orderId: order.id,
    amount,
    amountInPaise: toPaise(amount),
    currency: order.currency || 'INR',
    keyId: cfg.razorpayKeyIdMasked || null,
    paymentType: 'APPLICATION_PURCHASE',
  };
}

async function createOrderForCreditRecharge({ businessId, userId, requestedAmount }) {
  const { licenseStatus } = await licenseService.getLicenseOverview(businessId);
  if (licenseStatus !== 'PERMANENT_LICENSE') {
    throw new Error('PERMANENT_LICENSE_REQUIRED');
  }

  const parsed = toTwo(requestedAmount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('INVALID_RECHARGE_AMOUNT');
  }

  const amount = parsed;
  const creditsPurchased = amount;
  const receipt = buildReceipt('CREDIT_RECHARGE', businessId);

  console.info('[PAYMENT_INITIATED]', {
    businessId: String(businessId),
    userId: String(userId),
    paymentType: 'CREDIT_RECHARGE',
    amount,
    creditsPurchased,
  });

  const order = await razorpayService.createOrder({
    amountInPaise: toPaise(amount),
    receipt,
    notes: {
      paymentType: 'CREDIT_RECHARGE',
      businessId: String(businessId),
      initiatedByUserId: String(userId),
      creditsPurchased: String(creditsPurchased),
    },
  });

  console.info('[ORDER_CREATED]', {
    businessId: String(businessId),
    userId: String(userId),
    paymentType: 'CREDIT_RECHARGE',
    orderId: order.id,
    amount,
  });

  await PaymentTransaction.create({
    businessId,
    initiatedByUserId: userId,
    paymentType: 'CREDIT_RECHARGE',
    orderId: order.id,
    receipt,
    amount,
    baseAmount: amount,
    gstAmount: 0,
    amountInPaise: toPaise(amount),
    currency: order.currency || 'INR',
    creditsPurchased,
    status: 'ORDER_CREATED',
    idempotencyKey: `${order.id}:CREDIT_RECHARGE`,
  });

  return {
    orderId: order.id,
    amount,
    amountInPaise: toPaise(amount),
    currency: order.currency || 'INR',
    creditsPurchased,
    paymentType: 'CREDIT_RECHARGE',
  };
}

async function applyPaymentEffects({ txn, paymentPayload = {}, source = 'VERIFY_API' }) {
  if (txn.walletCredited && txn.status === 'PAYMENT_SUCCESS') {
    const wallet = await walletService.ensureWallet(txn.businessId);
    return { txn, wallet, idempotent: true };
  }

  const business = await Business.findById(txn.businessId);
  const actorUserId = txn.initiatedByUserId;

  let wallet = await walletService.ensureWallet(txn.businessId);

  if (txn.paymentType === 'APPLICATION_PURCHASE') {
    const existingBonusTx = await CreditTransaction.findOne({
      businessId: txn.businessId,
      type: 'BONUS',
      'metadata.orderId': txn.orderId,
    }).lean();

    const existingLicenseTx = await LicenseTransaction.findOne({
      businessId: txn.businessId,
      orderId: txn.orderId,
      type: 'LICENSE',
    }).lean();

    const existingBonusLicenseTx = await LicenseTransaction.findOne({
      businessId: txn.businessId,
      orderId: txn.orderId,
      type: 'BONUS',
    }).lean();

    const cfg = await billingConfigService.getEffectiveConfig();
    const licenseAmount = Number(cfg.applicationPrice || txn.amount);
    const bonusCredits = Number(cfg.purchasedBonusCredits || 1000);

    const purchaseResult = await licenseService.activatePermanentLicense({
      businessId: txn.businessId,
      actorUserId,
      purchaseAmount: licenseAmount,
      purchaseDate: new Date(),
      orderId: txn.orderId,
      paymentId: txn.paymentId,
      invoiceNumber: txn.invoiceNumber || null,
    });

    if (purchaseResult.activated && !existingLicenseTx) {
      await LicenseTransaction.create({
        businessId: txn.businessId,
        paymentTransactionId: txn._id,
        orderId: txn.orderId,
        paymentId: txn.paymentId,
        type: 'LICENSE',
        amount: licenseAmount,
        credits: 0,
        status: 'SUCCESS',
        note: `Permanent license activation via ${source}`,
      });
    }

    if (purchaseResult.activated && !existingBonusTx) {
      await creditService.grantPurchaseBonusCredits({
        businessId: txn.businessId,
        actionByUserId: actorUserId,
        credits: bonusCredits,
        note: `Application purchase bonus via ${source} (${txn.orderId})`,
        metadata: {
          orderId: txn.orderId,
          paymentId: txn.paymentId,
          paymentType: txn.paymentType,
          source,
        },
      });
      wallet = await walletService.ensureWallet(txn.businessId);
    }

    if (purchaseResult.activated && !existingBonusLicenseTx) {
      await LicenseTransaction.create({
        businessId: txn.businessId,
        paymentTransactionId: txn._id,
        orderId: txn.orderId,
        paymentId: txn.paymentId,
        type: 'BONUS',
        amount: 0,
        credits: bonusCredits,
        status: 'SUCCESS',
        note: `Bonus credits granted via ${source}`,
      });
    }

    if (purchaseResult.activated && (!existingBonusTx || !existingBonusLicenseTx)) {
      console.info('[BONUS_CREDIT_ADDED]', {
        businessId: String(txn.businessId),
        orderId: txn.orderId,
        credits: bonusCredits,
        source,
      });
    }

    txn.applicationActivated = true;
  } else if (txn.paymentType === 'CREDIT_RECHARGE') {
    const existingRechargeTx = await CreditTransaction.findOne({
      businessId: txn.businessId,
      type: 'CREDIT_ADD',
      'metadata.orderId': txn.orderId,
    }).lean();

    if (!existingRechargeTx) {
      await walletService.addCredits({
        businessId: txn.businessId,
        amount: txn.creditsPurchased,
        actionByUserId: actorUserId,
        userId: actorUserId,
        type: 'CREDIT_ADD',
        note: `Credit recharge via ${source}`,
        metadata: {
          paymentType: txn.paymentType,
          orderId: txn.orderId,
          paymentId: txn.paymentId,
        },
      });
    }
    wallet = await walletService.ensureWallet(txn.businessId);
  }

  txn.walletCredited = true;
  txn.status = 'PAYMENT_SUCCESS';
  txn.verifiedAt = new Date();
  txn.capturedAt = new Date();
  txn.invoiceNumber = txn.invoiceNumber || buildInvoiceNumber();
  txn.invoiceDate = txn.invoiceDate || new Date();
  txn.organizationLegalName = business?.legalName || '';
  txn.organizationTradeName = business?.tradeName || '';
  txn.organizationGstNumber = business?.gstNumber || '';
  txn.gatewayResponse = {
    ...(txn.gatewayResponse || {}),
    paymentPayload,
    source,
  };
  await txn.save();

  console.info('[PAYMENT_SUCCESS]', {
    orderId: txn.orderId,
    paymentId: txn.paymentId,
    paymentType: txn.paymentType,
    amount: txn.amount,
    businessId: String(txn.businessId),
    source,
  });

  return { txn, wallet, idempotent: false };
}

async function verifyPaymentAndApply({ businessId, userId, orderId, paymentId, signature }) {
  const txn = await PaymentTransaction.findOne({ orderId, businessId });
  if (!txn) {
    throw new Error('PAYMENT_ORDER_NOT_FOUND');
  }

  txn.verificationAttempts = (txn.verificationAttempts || 0) + 1;

  const signatureOk = razorpayService.verifyPaymentSignature({ orderId, paymentId, signature });
  if (!signatureOk) {
    txn.status = 'VERIFICATION_FAILED';
    txn.failureReason = 'Invalid Razorpay signature';
    txn.paymentId = paymentId || null;
    txn.razorpaySignature = signature || null;
    await txn.save();

    console.warn('[SIGNATURE_FAILED]', {
      orderId,
      paymentId,
      businessId: String(businessId),
      userId: String(userId),
    });

    throw new Error('INVALID_PAYMENT_SIGNATURE');
  }

  console.info('[SIGNATURE_VERIFIED]', {
    orderId,
    paymentId,
    businessId: String(businessId),
    userId: String(userId),
  });

  const payment = await razorpayService.fetchPayment(paymentId);
  const expectedAmountInPaise = txn.amountInPaise;
  const paidAmount = Number(payment.amount || 0);

  if (paidAmount !== expectedAmountInPaise) {
    txn.status = 'VERIFICATION_FAILED';
    txn.failureReason = `Amount mismatch. expected=${expectedAmountInPaise}, actual=${paidAmount}`;
    txn.paymentId = paymentId;
    txn.razorpaySignature = signature;
    txn.gatewayResponse = { ...(txn.gatewayResponse || {}), payment };
    await txn.save();
    throw new Error('PAYMENT_AMOUNT_MISMATCH');
  }

  if (!['captured', 'authorized'].includes(String(payment.status || '').toLowerCase())) {
    txn.status = 'PAYMENT_PENDING';
    txn.paymentId = paymentId;
    txn.razorpaySignature = signature;
    txn.gatewayResponse = { ...(txn.gatewayResponse || {}), payment };
    await txn.save();
    throw new Error('PAYMENT_NOT_CAPTURED');
  }

  txn.paymentId = paymentId;
  txn.razorpaySignature = signature;
  txn.gatewayResponse = { ...(txn.gatewayResponse || {}), payment };

  return applyPaymentEffects({ txn, paymentPayload: payment, source: 'VERIFY_API' });
}

async function processPaymentCapturedWebhook({ orderId, paymentId, paymentPayload, gatewaySignature = '' }) {
  const txn = await PaymentTransaction.findOne({ orderId });
  if (!txn) {
    return { ignored: true, reason: 'ORDER_NOT_FOUND' };
  }

  if (txn.paymentId && txn.paymentId !== paymentId) {
    return { ignored: true, reason: 'PAYMENT_ID_MISMATCH' };
  }

  txn.paymentId = paymentId;
  if (gatewaySignature) {
    txn.razorpaySignature = gatewaySignature;
  }

  const payloadAmount = Number(paymentPayload?.amount || 0);
  if (payloadAmount !== txn.amountInPaise) {
    txn.status = 'VERIFICATION_FAILED';
    txn.failureReason = `Webhook amount mismatch. expected=${txn.amountInPaise}, actual=${payloadAmount}`;
    await txn.save();
    return { ignored: true, reason: 'AMOUNT_MISMATCH' };
  }

  return applyPaymentEffects({ txn, paymentPayload, source: 'WEBHOOK_CAPTURED' });
}

async function processPaymentFailedWebhook({ orderId, paymentId, failureReason = '', paymentPayload = {} }) {
  const txn = await PaymentTransaction.findOne({ orderId });
  if (!txn) {
    return { ignored: true, reason: 'ORDER_NOT_FOUND' };
  }

  if (txn.status === 'PAYMENT_SUCCESS') {
    return { ignored: true, reason: 'ALREADY_SUCCESS' };
  }

  txn.status = 'PAYMENT_FAILED';
  txn.paymentId = paymentId || txn.paymentId;
  txn.failureReason = failureReason || 'Gateway payment failure';
  txn.gatewayResponse = { ...(txn.gatewayResponse || {}), paymentPayload };
  await txn.save();

  console.warn('[PAYMENT_FAILED]', {
    orderId,
    paymentId,
    reason: txn.failureReason,
    businessId: String(txn.businessId),
  });

  return { ignored: false, txn };
}

async function processRefundWebhook({ orderId, paymentId, refundPayload = {} }) {
  const txn = await PaymentTransaction.findOne({ orderId });
  if (!txn) {
    return { ignored: true, reason: 'ORDER_NOT_FOUND' };
  }

  if (txn.status === 'REFUNDED') {
    return { ignored: true, reason: 'ALREADY_REFUNDED' };
  }

  txn.status = 'REFUNDED';
  txn.paymentId = paymentId || txn.paymentId;
  txn.gatewayResponse = { ...(txn.gatewayResponse || {}), refundPayload };
  await txn.save();

  console.info('[PAYMENT_REFUNDED]', {
    orderId,
    paymentId,
    businessId: String(txn.businessId),
  });

  return { ignored: false, txn };
}

async function getPaymentHistory({ businessId, page = 1, limit = 20 }) {
  const safePage = Math.max(1, Number(page || 1));
  const safeLimit = Math.min(200, Math.max(1, Number(limit || 20)));
  const skip = (safePage - 1) * safeLimit;

  const [records, totalRecords] = await Promise.all([
    PaymentTransaction.find({ businessId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    PaymentTransaction.countDocuments({ businessId }),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalRecords / safeLimit));

  return {
    records,
    page: safePage,
    limit: safeLimit,
    totalRecords,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPrevPage: safePage > 1,
  };
}

async function getMonthCostSummary({ businessId }) {
  const { dayKey, monthKey } = getStatsKeys(new Date());
  const billingTimeZone = config.billing?.timezone || 'Asia/Kolkata';

  const ScanBilling = require('../models/scanBilling.model');
  const businessObjectId = new mongoose.Types.ObjectId(String(businessId));

  const [monthRows, todayRows] = await Promise.all([
    ScanBilling.aggregate([
      {
        $match: {
          businessId: businessObjectId,
          billingStatus: { $ne: 'FAILED', $nin: ['PENDING', 'RECONCILIATION_REQUIRED'] },
          $expr: {
            $eq: [
              {
                $dateToString: {
                  format: '%Y-%m',
                  date: '$billedAt',
                  timezone: billingTimeZone,
                },
              },
              monthKey,
            ],
          },
        },
      },
      { $group: { _id: null, total: { $sum: '$totalScanCharge' }, count: { $sum: 1 } } },
    ]),
    ScanBilling.aggregate([
      {
        $match: {
          businessId: businessObjectId,
          billingStatus: { $ne: 'FAILED', $nin: ['PENDING', 'RECONCILIATION_REQUIRED'] },
          $expr: {
            $eq: [
              {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$billedAt',
                  timezone: billingTimeZone,
                },
              },
              dayKey,
            ],
          },
        },
      },
      { $group: { _id: null, total: { $sum: '$totalScanCharge' }, count: { $sum: 1 } } },
    ]),
  ]);

  return {
    currentMonthCost: toTwo(monthRows[0]?.total || 0),
    todayScanCost: toTwo(todayRows[0]?.total || 0),
    monthScans: Number(monthRows[0]?.count || 0),
    todayScans: Number(todayRows[0]?.count || 0),
  };
}

module.exports = {
  createOrderForApplicationPurchase,
  createOrderForCreditRecharge,
  verifyPaymentAndApply,
  processPaymentCapturedWebhook,
  processPaymentFailedWebhook,
  processRefundWebhook,
  getPaymentHistory,
  getMonthCostSummary,
};

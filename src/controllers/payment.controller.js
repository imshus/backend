const { sendSuccess } = require('../utils/apiResponse');
const paymentService = require('../services/payment.service');
const billingConfigService = require('../services/billingConfig.service');

async function createApplicationOrder(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const userId = req.user.userId;
    const order = await paymentService.createOrderForApplicationPurchase({ businessId, userId });
    const cfg = await billingConfigService.getEffectiveConfig();
    sendSuccess(res, {
      ...order,
      razorpayKeyId: req.app.locals.razorpayKeyId || null,
      applicationPrice: cfg.applicationPrice,
    });
  } catch (error) {
    next(error);
  }
}

async function createCreditOrder(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const userId = req.user.userId;
    const amount = Number(req.body?.amount || 0);

    const order = await paymentService.createOrderForCreditRecharge({
      businessId,
      userId,
      requestedAmount: amount,
    });

    sendSuccess(res, {
      ...order,
      razorpayKeyId: req.app.locals.razorpayKeyId || null,
    });
  } catch (error) {
    next(error);
  }
}

async function verifyPayment(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const userId = req.user.userId;
    const { orderId, paymentId, signature } = req.body || {};

    if (!orderId || !paymentId || !signature) {
      throw new Error('PAYMENT_VERIFICATION_INPUT_MISSING');
    }

    const result = await paymentService.verifyPaymentAndApply({
      businessId,
      userId,
      orderId,
      paymentId,
      signature,
    });

    sendSuccess(res, {
      success: true,
      idempotent: result.idempotent,
      orderId: result.txn.orderId,
      paymentId: result.txn.paymentId,
      status: result.txn.status,
      paymentType: result.txn.paymentType,
      invoiceNumber: result.txn.invoiceNumber,
      invoiceDate: result.txn.invoiceDate,
      walletBalance: result.wallet.creditBalance,
    });
  } catch (error) {
    next(error);
  }
}

async function markPaymentFailure(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const { orderId, paymentId, reason, status } = req.body || {};

    if (!orderId) {
      throw new Error('PAYMENT_ORDER_NOT_FOUND');
    }

    await paymentService.processPaymentFailedWebhook({
      orderId,
      paymentId,
      failureReason: reason || status || 'Payment failed from client callback',
      paymentPayload: {
        source: 'CLIENT_CALLBACK',
        businessId,
      },
    });

    sendSuccess(res, { success: true });
  } catch (error) {
    next(error);
  }
}

async function getPaymentHistory(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const page = Number(req.query?.page || 1);
    const limit = Number(req.query?.limit || 20);
    const history = await paymentService.getPaymentHistory({ businessId, page, limit });
    sendSuccess(res, history);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createApplicationOrder,
  createCreditOrder,
  verifyPayment,
  markPaymentFailure,
  getPaymentHistory,
};

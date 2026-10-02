const { sendSuccess } = require('../utils/apiResponse');
const { isEmail } = require('../utils/email');
const Business = require('../models/business.model');
const paymentService = require('../services/payment.service');
const paymentInvoiceService = require('../services/paymentInvoice.service');

/**
 * The email the shop typed in the popup before paying, kept on the shop so
 * the next payment offers it again. An app from before the popup sends none,
 * and pays as it always did; a typed value that is not an address is refused
 * before any order exists.
 */
async function saveBillingEmail(businessId, raw) {
  const email = String(raw ?? '').trim();
  if (!email) return;
  if (!isEmail(email)) throw new Error('BILLING_EMAIL_INVALID');
  await Business.updateOne({ _id: businessId }, { $set: { billingEmail: email } });
}

async function createApplicationOrder(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const userId = req.user.userId;
    await saveBillingEmail(businessId, req.body?.email);
    const order = await paymentService.createOrderForApplicationPurchase({ businessId, userId });
    sendSuccess(res, {
      ...order,
      razorpayKeyId: req.app.locals.razorpayKeyId || null,
      // The price before GST, from the same computation as the charge.
      applicationPrice: order.baseAmount,
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

    await saveBillingEmail(businessId, req.body?.email);
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
    const { orderId, reason, status } = req.body || {};

    if (!orderId) {
      throw new Error('PAYMENT_ORDER_NOT_FOUND');
    }

    // No payment id from the client: one planted here before paying would
    // make the captured webhook's real id a mismatch. The signed webhook is
    // the only source of that id.
    await paymentService.processPaymentFailedWebhook({
      orderId,
      businessId,
      failureReason: String(reason || status || 'Payment failed from client callback').slice(0, 300),
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

async function getPaymentInvoice(req, res, next) {
  try {
    const invoice = await paymentInvoiceService.getPaymentInvoice({
      businessId: req.user.businessId,
      orderId: req.params.orderId,
    });
    sendSuccess(res, invoice);
  } catch (error) {
    next(error);
  }
}

async function emailPaymentInvoice(req, res, next) {
  try {
    // { auto: true }: the app's own send straight after paying, once only.
    if (req.body?.auto === true) {
      const sent = await paymentInvoiceService.autoEmailPaymentInvoice({
        businessId: req.user.businessId,
        orderId: req.params.orderId,
      });
      return sendSuccess(res, sent);
    }
    const result = await paymentInvoiceService.emailPaymentInvoice({
      businessId: req.user.businessId,
      orderId: req.params.orderId,
      email: req.body?.email,
    });
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getPaymentInvoice,
  emailPaymentInvoice,
  createApplicationOrder,
  createCreditOrder,
  verifyPayment,
  markPaymentFailure,
  getPaymentHistory,
};

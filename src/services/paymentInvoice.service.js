const PaymentTransaction = require('../models/paymentTransaction.model');
const Business = require('../models/business.model');
const billingConfigService = require('./billingConfig.service');
const mailService = require('./mail.service');
const config = require('../config/env');
const { isEmail } = require('../utils/email');
const { buildPaymentInvoice } = require('../utils/paymentInvoiceHtml');

/**
 * Emails MRPscan's invoice for a successful licence or credit payment to the
 * billing email the shop typed in the popup before paying.
 *
 * Sent at most once per payment: the payment is claimed (invoiceEmailedAt
 * set) before the message goes out, so the app's verify call and Razorpay's
 * webhook arriving together cannot both send it. A failed send releases the
 * claim, so a later attempt may try again. Skipped quietly without SMTP or an
 * email: the payment itself has already succeeded and must not be touched.
 *
 * Resolves to { sent, reason }.
 */
async function sendPaymentInvoice(txnId) {
  if (!mailService.isConfigured()) return { sent: false, reason: 'SMTP_NOT_CONFIGURED' };

  const txn = await PaymentTransaction.findById(txnId).lean();
  if (!txn || txn.status !== 'PAYMENT_SUCCESS') return { sent: false, reason: 'NOT_PAID' };
  if (txn.invoiceEmailedAt) return { sent: false, reason: 'ALREADY_SENT' };

  const business = await Business.findById(txn.businessId)
    .select('legalName tradeName gstNumber address stateCode stateName pincode billingEmail')
    .lean();
  const to = String(business?.billingEmail || '').trim();
  if (!isEmail(to)) return { sent: false, reason: 'NO_BILLING_EMAIL' };

  const claimed = await PaymentTransaction.findOneAndUpdate(
    { _id: txn._id, invoiceEmailedAt: null },
    { $set: { invoiceEmailedAt: new Date(), invoiceEmailedTo: to } },
    { new: true },
  ).lean();
  if (!claimed) return { sent: false, reason: 'ALREADY_SENT' };

  let bonusCredits = 0;
  if (txn.paymentType === 'APPLICATION_PURCHASE') {
    try {
      const cfg = await billingConfigService.getEffectiveConfig();
      bonusCredits = Number(cfg.purchasedBonusCredits || 0);
    } catch (_) {
      bonusCredits = 0;
    }
  }

  const invoice = buildPaymentInvoice({ txn: claimed, business, seller: config.invoiceSeller || {}, bonusCredits });
  try {
    await mailService.sendMail({
      to,
      subject: invoice.subject,
      text: invoice.text,
      html: invoice.html,
      fromName: 'MRPscan',
    });
  } catch (err) {
    await PaymentTransaction.updateOne(
      { _id: txn._id },
      { $set: { invoiceEmailedAt: null, invoiceEmailedTo: '' } },
    ).catch(() => {});
    throw err;
  }
  return { sent: true, to };
}

module.exports = { sendPaymentInvoice };

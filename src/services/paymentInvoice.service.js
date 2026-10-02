const PaymentTransaction = require('../models/paymentTransaction.model');
const Business = require('../models/business.model');
const mailService = require('./mail.service');
const config = require('../config/env');
const { isEmail } = require('../utils/email');
const { buildPaymentInvoice } = require('../utils/paymentInvoiceHtml');

const BUSINESS_FIELDS = 'legalName tradeName gstNumber address stateCode stateName pincode billingEmail';

/** MRPscan's invoice for one successful payment: subject, html, text, title. */
async function invoiceFor(txn, business) {
  return buildPaymentInvoice({ txn, business: business || {}, seller: config.invoiceSeller || {} });
}

const sendInvoiceMail = (to, invoice) => mailService.sendMail({
  to,
  subject: invoice.subject,
  text: invoice.text,
  html: invoice.html,
  fromName: 'MRPscan',
});

/**
 * Emails MRPscan's invoice for a successful licence or credit payment to the
 * billing email the shop typed in the popup before paying, right after the
 * payment.
 *
 * Sent at most once per payment this way: the payment is claimed
 * (invoiceEmailedAt set) before the message goes out, so the app's verify
 * call and Razorpay's webhook arriving together cannot both send it. A failed
 * send releases the claim. Skipped quietly without SMTP or an email: the
 * payment itself has already succeeded and must not be touched.
 *
 * Resolves to { sent, reason }.
 */
async function sendPaymentInvoice(txnId) {
  if (!mailService.isConfigured()) return { sent: false, reason: 'SMTP_NOT_CONFIGURED' };

  const txn = await PaymentTransaction.findById(txnId).lean();
  if (!txn || txn.status !== 'PAYMENT_SUCCESS') return { sent: false, reason: 'NOT_PAID' };
  if (txn.invoiceEmailedAt) return { sent: false, reason: 'ALREADY_SENT' };

  const business = await Business.findById(txn.businessId).select(BUSINESS_FIELDS).lean();
  const to = String(business?.billingEmail || '').trim();
  if (!isEmail(to)) return { sent: false, reason: 'NO_BILLING_EMAIL' };

  const claimed = await PaymentTransaction.findOneAndUpdate(
    { _id: txn._id, invoiceEmailedAt: null },
    { $set: { invoiceEmailedAt: new Date(), invoiceEmailedTo: to } },
    { new: true },
  ).lean();
  if (!claimed) return { sent: false, reason: 'ALREADY_SENT' };

  try {
    await sendInvoiceMail(to, await invoiceFor(claimed, business));
  } catch (err) {
    await PaymentTransaction.updateOne(
      { _id: txn._id },
      { $set: { invoiceEmailedAt: null, invoiceEmailedTo: '' } },
    ).catch(() => {});
    throw err;
  }
  return { sent: true, to };
}

/** This shop's successful payment for an order, or a coded error. */
async function paidTransaction(businessId, orderId) {
  const txn = await PaymentTransaction.findOne({ orderId: String(orderId || ''), businessId }).lean();
  if (!txn) throw new Error('PAYMENT_ORDER_NOT_FOUND');
  if (txn.status !== 'PAYMENT_SUCCESS') throw new Error('PAYMENT_INVOICE_NOT_READY');
  return txn;
}

/** The invoice for a shop's own paid order, to show in the app. */
async function getPaymentInvoice({ businessId, orderId }) {
  const txn = await paidTransaction(businessId, orderId);
  const business = await Business.findById(businessId).select(BUSINESS_FIELDS).lean();
  const invoice = await invoiceFor(txn, business);
  return {
    orderId: txn.orderId,
    invoiceNumber: txn.invoiceNumber || '',
    title: invoice.title,
    html: invoice.html,
    billingEmail: business?.billingEmail || '',
  };
}

/**
 * Emails a shop's own paid invoice when asked from the app, to the address
 * given (kept as the billing email) or the saved billing email. Unlike the
 * automatic send, this may be repeated: the shop asked for it.
 */
async function emailPaymentInvoice({ businessId, orderId, email }) {
  if (!mailService.isConfigured()) throw new Error('INVOICE_EMAIL_NOT_CONFIGURED');
  const txn = await paidTransaction(businessId, orderId);
  const typed = String(email ?? '').trim();
  if (typed && !isEmail(typed)) throw new Error('BILLING_EMAIL_INVALID');

  const business = await Business.findById(businessId).select(BUSINESS_FIELDS).lean();
  const to = typed || String(business?.billingEmail || '').trim();
  if (!isEmail(to)) throw new Error('BILLING_EMAIL_INVALID');
  if (typed && typed !== business?.billingEmail) {
    await Business.updateOne({ _id: businessId }, { $set: { billingEmail: typed } });
  }

  await sendInvoiceMail(to, await invoiceFor(txn, business));
  await PaymentTransaction.updateOne(
    { _id: txn._id },
    { $set: { invoiceEmailedAt: new Date(), invoiceEmailedTo: to } },
  ).catch(() => {});
  return { sentTo: to };
}

module.exports = { sendPaymentInvoice, getPaymentInvoice, emailPaymentInvoice };

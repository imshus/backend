/**
 * MRPscan's invoice for a licence or credit payment, emailed once to the
 * billing email from the payment popup. The template is pinned on its tax
 * lines and title; the sender on sending once, and only when it can.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const { buildPaymentInvoice, taxLines } = require('../src/utils/paymentInvoiceHtml');

const licenceTxn = {
  paymentType: 'APPLICATION_PURCHASE',
  amount: 14160,
  baseAmount: 12000,
  gstAmount: 2160,
  invoiceNumber: 'INV-261002-482915',
  invoiceDate: new Date('2026-10-02T06:45:00Z'),
  capturedAt: new Date('2026-10-02T06:45:00Z'),
  paymentId: 'pay_1',
  orderId: 'order_1',
};
const shop = { tradeName: 'Gupta Jewellers', legalName: 'Gupta Jewellers Pvt. Ltd.', gstNumber: '27AABCG1234F1Z5', stateCode: '27' };

test('same state: CGST + SGST; another state: IGST; unknown: one GST line; none on credits', () => {
  assert.deepEqual(taxLines({ gstAmount: 2160, gstPercent: 18, sellerState: '27', buyerState: '27' }), [
    { label: 'CGST @ 9%', amount: 1080 },
    { label: 'SGST @ 9%', amount: 1080 },
  ]);
  assert.deepEqual(taxLines({ gstAmount: 2160, gstPercent: 18, sellerState: '09', buyerState: '27' }), [
    { label: 'IGST @ 18%', amount: 2160 },
  ]);
  assert.deepEqual(taxLines({ gstAmount: 2160, gstPercent: 18, sellerState: '', buyerState: '27' }), [
    { label: 'GST @ 18%', amount: 2160 },
  ]);
  assert.deepEqual(taxLines({ gstAmount: 0, gstPercent: 0, sellerState: '27', buyerState: '27' }), []);
  // Odd paise split so the two halves still add up to the GST charged.
  const [c, s] = taxLines({ gstAmount: 0.03, gstPercent: 18, sellerState: '27', buyerState: '27' });
  assert.equal(Math.round((c.amount + s.amount) * 100), 3);
});

test('a Tax Invoice only with the seller GSTIN; a Payment Receipt without it', () => {
  const withGstin = buildPaymentInvoice({ txn: licenceTxn, business: shop, seller: { gstin: '27ABCDE1234F1Z5' }, bonusCredits: 1000 });
  assert.equal(withGstin.title, 'Tax Invoice');
  assert.match(withGstin.html, /CGST @ 9%/);
  assert.match(withGstin.html, /₹ 14,160\.00/);
  assert.match(withGstin.html, /1,000 bonus credits included/);
  assert.match(withGstin.subject, /^MRPscan Tax Invoice INV-261002-482915/);

  const without = buildPaymentInvoice({ txn: licenceTxn, business: shop, seller: { gstin: '' } });
  assert.equal(without.title, 'Payment Receipt');
  assert.doesNotMatch(without.html, /Tax Invoice/);
});

test('a credit recharge prints its credits and no tax lines', () => {
  const credits = buildPaymentInvoice({
    txn: { ...licenceTxn, paymentType: 'CREDIT_RECHARGE', amount: 500, baseAmount: 500, gstAmount: 0, creditsPurchased: 500 },
    business: shop,
    seller: { gstin: '27ABCDE1234F1Z5' },
  });
  assert.match(credits.html, /MRPscan Scan Credits/);
  assert.doesNotMatch(credits.html, /GST @/);
  assert.match(credits.text, /Total paid: ₹ 500\.00/);
});

test("the shop's own words are escaped, never markup", () => {
  const { html } = buildPaymentInvoice({
    txn: licenceTxn,
    business: { ...shop, tradeName: '<script>alert(1)</script> & Sons' },
    seller: {},
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Sons/);
});

// ---- sender, with its database and mail stubbed

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'paymentInvoice.service.js');
const state = {};
const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: SERVICE,
    filename: SERVICE,
    paths: Module._nodeModulePaths(path.dirname(SERVICE)),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stub('../models/paymentTransaction.model', {
  findById: () => ({ lean: async () => state.txn }),
  findOne: (filter) => ({
    lean: async () => {
      state.findOneFilter = filter;
      return filter.orderId === state.txn.orderId && filter.businessId === state.txn.businessId ? state.txn : null;
    },
  }),
  findOneAndUpdate: (filter, update) => ({
    lean: async () => {
      state.claims += 1;
      if (state.txn.invoiceEmailedAt) return null;
      Object.assign(state.txn, update.$set);
      return { ...state.txn };
    },
  }),
  updateOne: async (filter, update) => { Object.assign(state.txn, update.$set); },
});
stub('../models/business.model', {
  findById: () => ({ select: () => ({ lean: async () => state.business }) }),
  updateOne: async (filter, update) => { state.businessUpdates.push(update.$set); },
});
stub('./billingConfig.service', { getEffectiveConfig: async () => ({ purchasedBonusCredits: 1000 }) });
stub('./mail.service', {
  isConfigured: () => state.configured,
  sendMail: async (message) => {
    if (state.sendThrows) throw new Error('SMTP down');
    state.sent.push(message);
  },
});
stub('../config/env', { invoiceSeller: { name: 'Amitaash IT Solutions Private Limited', gstin: '', email: 'info@mrpscan.com' } });
const { sendPaymentInvoice, getPaymentInvoice, emailPaymentInvoice } = require(SERVICE);

const reset = () => Object.assign(state, {
  txn: { ...licenceTxn, _id: 't1', businessId: 'b1', status: 'PAYMENT_SUCCESS', invoiceEmailedAt: null },
  business: { ...shop, billingEmail: 'owner@shop.in' },
  configured: true,
  sendThrows: false,
  sent: [],
  claims: 0,
  businessUpdates: [],
  findOneFilter: null,
});

test('emails the invoice to the billing email, once', async () => {
  reset();
  assert.deepEqual(await sendPaymentInvoice('t1'), { sent: true, to: 'owner@shop.in' });
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].to, 'owner@shop.in');
  assert.match(state.sent[0].html, /Payment Receipt/);
  assert.equal(state.txn.invoiceEmailedTo, 'owner@shop.in');
  // The webhook arriving after the verify call sends nothing more.
  assert.equal((await sendPaymentInvoice('t1')).reason, 'ALREADY_SENT');
  assert.equal(state.sent.length, 1);
});

test('skips without SMTP, without an email, or for an unpaid order', async () => {
  reset();
  state.configured = false;
  assert.equal((await sendPaymentInvoice('t1')).reason, 'SMTP_NOT_CONFIGURED');
  reset();
  state.business.billingEmail = '';
  assert.equal((await sendPaymentInvoice('t1')).reason, 'NO_BILLING_EMAIL');
  reset();
  state.txn.status = 'ORDER_CREATED';
  assert.equal((await sendPaymentInvoice('t1')).reason, 'NOT_PAID');
  assert.equal(state.sent.length, 0);
});

test('a failed send releases the claim so it can be tried again', async () => {
  reset();
  state.sendThrows = true;
  await assert.rejects(() => sendPaymentInvoice('t1'), /SMTP down/);
  assert.equal(state.txn.invoiceEmailedAt, null);
  state.sendThrows = false;
  assert.equal((await sendPaymentInvoice('t1')).sent, true);
});

test('the app shows the invoice for its own paid order only', async () => {
  reset();
  const invoice = await getPaymentInvoice({ businessId: 'b1', orderId: 'order_1' });
  assert.equal(invoice.title, 'Payment Receipt');
  assert.match(invoice.html, /MRPscan Application Licence/);
  assert.equal(invoice.billingEmail, 'owner@shop.in');
  assert.deepEqual(state.findOneFilter, { orderId: 'order_1', businessId: 'b1' });
  await assert.rejects(() => getPaymentInvoice({ businessId: 'b2', orderId: 'order_1' }), /PAYMENT_ORDER_NOT_FOUND/);
  state.txn.status = 'ORDER_CREATED';
  await assert.rejects(() => getPaymentInvoice({ businessId: 'b1', orderId: 'order_1' }), /PAYMENT_INVOICE_NOT_READY/);
});

test('Email Invoice sends on request, again if asked, to a typed address kept for next time', async () => {
  reset();
  state.txn.invoiceEmailedAt = new Date(); // already sent automatically
  assert.deepEqual(await emailPaymentInvoice({ businessId: 'b1', orderId: 'order_1' }), { sentTo: 'owner@shop.in' });
  assert.deepEqual(await emailPaymentInvoice({ businessId: 'b1', orderId: 'order_1', email: 'accounts@shop.in' }), { sentTo: 'accounts@shop.in' });
  assert.equal(state.sent.length, 2);
  assert.equal(state.sent[1].to, 'accounts@shop.in');
  assert.deepEqual(state.businessUpdates, [{ billingEmail: 'accounts@shop.in' }]);
});

test('Email Invoice refuses a bad address and a server without SMTP', async () => {
  reset();
  await assert.rejects(() => emailPaymentInvoice({ businessId: 'b1', orderId: 'order_1', email: 'nope' }), /BILLING_EMAIL_INVALID/);
  state.business.billingEmail = '';
  await assert.rejects(() => emailPaymentInvoice({ businessId: 'b1', orderId: 'order_1' }), /BILLING_EMAIL_INVALID/);
  state.configured = false;
  await assert.rejects(() => emailPaymentInvoice({ businessId: 'b1', orderId: 'order_1', email: 'a@b.co' }), /INVOICE_EMAIL_NOT_CONFIGURED/);
  assert.equal(state.sent.length, 0);
});

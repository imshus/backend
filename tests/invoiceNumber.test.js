/**
 * Invoice numbers fit the sixteen characters CGST Rule 46(1)(b) and the
 * e-invoice DocDtls.No allow, never repeat for a shop within a financial
 * year, and carry the India date the invoice prints. The old
 * INV-YYYY-MMDD-NNNNN was nineteen characters, so no live IRN request could
 * pass the schema.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  InvoiceCounter,
  generateInvoiceNumber,
  peekNextInvoiceNumber,
  INVOICE_NUMBER_PATTERN,
} = require('../src/models/invoiceCounter.model');
const { generateEInvoice } = require('../src/services/einvoice.service');

const counters = new Map();
const original = { update: InvoiceCounter.findOneAndUpdate, find: InvoiceCounter.findOne };
test.before(() => {
  InvoiceCounter.findOneAndUpdate = async (filter) => {
    const key = `${filter.businessId}|${filter.dateKey}`;
    counters.set(key, (counters.get(key) || 0) + 1);
    return { seq: counters.get(key) };
  };
  InvoiceCounter.findOne = async (filter) => {
    const key = `${filter.businessId}|${filter.dateKey}`;
    return counters.has(key) ? { seq: counters.get(key) } : null;
  };
});
test.after(() => {
  InvoiceCounter.findOneAndUpdate = original.update;
  InvoiceCounter.findOne = original.find;
});

test('the number is the financial year, the India date and the day\'s sequence, in sixteen characters', async () => {
  const number = await generateInvoiceNumber('shop-fmt', new Date('2026-10-15T06:00:00Z'));
  assert.equal(number, '26-27/1015/00001');
  assert.equal(number.length, 16);
  assert.match(number, INVOICE_NUMBER_PATTERN);
  assert.equal(await peekNextInvoiceNumber('shop-fmt', new Date('2026-10-15T06:00:00Z')), '26-27/1015/00002');
});

test('the financial year turns on 1 April, and January to March belong to the year before', async () => {
  assert.equal(await generateInvoiceNumber('shop-fy', new Date('2027-03-31T12:00:00Z')), '26-27/0331/00001');
  assert.equal(await generateInvoiceNumber('shop-fy', new Date('2027-04-01T12:00:00Z')), '27-28/0401/00001');
  assert.equal(await generateInvoiceNumber('shop-fy', new Date('2027-01-05T12:00:00Z')), '26-27/0105/00001');
});

test('the date is India\'s: 00:30 IST is already the next day on a UTC server', async () => {
  // 2026-10-14 19:00 UTC is 2026-10-15 00:30 IST.
  assert.equal(await generateInvoiceNumber('shop-ist', new Date('2026-10-14T19:00:00Z')), '26-27/1015/00001');
  // And 23:59 IST on 31 March is still the old financial year.
  assert.equal(await generateInvoiceNumber('shop-ist', new Date('2027-03-31T18:29:00Z')), '26-27/0331/00001');
});

test('no number repeats for a shop across a whole financial year, and each fits the IRP pattern', async () => {
  const seen = new Set();
  const start = Date.parse('2026-04-01T06:00:00Z');
  for (let day = 0; day < 365; day += 1) {
    const when = new Date(start + day * 86400000);
    for (let n = 0; n < 3; n += 1) {
      const number = await generateInvoiceNumber('shop-year', when);
      assert.ok(number.length <= 16, number);
      assert.match(number, INVOICE_NUMBER_PATTERN);
      assert.ok(!seen.has(number), `repeated ${number}`);
      seen.add(number);
    }
  }
  assert.equal(seen.size, 365 * 3);
});

test('an e-invoice under an old nineteen-character number is refused before anything is sent', async () => {
  const calls = [];
  const deps = {
    axios: { post: async (...args) => { calls.push(args); return { data: {} }; } },
    getAccessToken: async () => { calls.push('token'); return 'token'; },
  };
  const payload = {
    invoice_number: 'INV-2026-1015-00001',
    invoice_date: '15-10-2026',
    customer_name: 'Referred Jewels',
    customer_gstin: '09AKFPV8673D2ZK',
    gst_rate: 3,
    is_intra_state: false,
    line_items: [{ description: 'Gold', qty: 1, qty_unit: 'Gms.', price: 100, amount: 100 }],
    grand_total: 103,
  };
  await assert.rejects(
    () => generateEInvoice({ payload, business: { gstNumber: '07AAACR5055K1Z7' } }, deps),
    /EINVOICE_DOC_NO_INVALID:INV-2026-1015-00001/,
  );
  assert.deepEqual(calls, [], 'no token fetched, nothing posted');
});

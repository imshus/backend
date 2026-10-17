/**
 * Settings -> History -> Checkout history reads GET /invoices, which lists
 * invoices without their lines. A row says "Cart · N items", so an invoice
 * keeps how many pieces it bills (pieceCount): the one scanned piece unless
 * the request says otherwise. An invoice issued before it was kept answers
 * null, and the app names it by its number instead.
 *
 * The controller runs with its models and PDF service stubbed (as in
 * invoiceGst.test.js); nothing is rendered or sent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const CONTROLLER = path.join(__dirname, '..', 'src', 'controllers', 'invoice.controller.js');
const CONTROLLER_DIR = path.dirname(CONTROLLER);

const state = { numbersTaken: 0, created: [], listed: [], listQuery: null };

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: CONTROLLER,
    filename: CONTROLLER,
    paths: Module._nodeModulePaths(CONTROLLER_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

/** Invoice.find(...).sort().skip().limit().select().lean(), recording the query. */
const listQuery = (filter) => {
  const query = { filter, select: null };
  state.listQuery = query;
  const chain = {
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    select: (fields) => {
      query.select = fields;
      return chain;
    },
    lean: async () => state.listed.map((invoice) => ({ ...invoice })),
  };
  return chain;
};

stub('../models/invoice.model', {
  create: async (doc) => {
    state.created.push(doc);
    return { ...doc, _id: `inv-${state.created.length}` };
  },
  findByIdAndUpdate: async () => ({}),
  find: listQuery,
  countDocuments: async () => state.listed.length,
});
stub('qrcode', { toDataURL: async () => 'data:image/png;base64,qr' });
stub('../models/business.model', {
  findById: () => ({ lean: async () => ({ gstNumber: '27AAAAA0000A1Z5', legalName: 'Shree Jewellers', address: 'Mumbai' }) }),
});
stub('../models/businessUser.model', { findById: () => ({ select: () => ({ lean: async () => null }) }) });
stub('../models/employee.model', { findById: () => ({ select: () => ({ lean: async () => null }) }) });
stub('../models/invoiceCounter.model', {
  generateInvoiceNumber: async () => {
    state.numbersTaken += 1;
    return `26-27/1017/${String(state.numbersTaken).padStart(5, '0')}`;
  },
  peekNextInvoiceNumber: async () => `26-27/1017/${String(state.numbersTaken + 1).padStart(5, '0')}`,
});
stub('../services/pdfmonkey.service', {
  generateInvoicePdf: async () => ({ downloadUrl: '', docId: '' }),
  getDownloadUrl: async () => '',
});
stub('../services/redis.service', {
  claimInvoiceToken: async () => false,
  setInvoicePdfCache: async () => {},
  getInvoicePdfCache: async () => null,
  finishLatestAnalyzedScan: async () => {},
});
stub('../config/env', {
  publicBaseUrl: 'https://amitaash.com',
  invoicePdfCache: { maxBytes: 15 * 1024 * 1024 },
  einvoice: { credKey: '' },
  sandbox: {},
});
stub('../utils/apiResponse', {
  sendSuccess: (res, data, status = 200) => res.finish(status, data),
  sendError: (res, message, status = 400) => res.finish(status, { message }),
});

const { generateInvoice, getInvoices } = require(CONTROLLER);

const gold = (amount) => ({
  description: 'Gold (in grams)', qty: 10, qty_unit: 'Gms.', hsn: '71131913', price: amount / 10, amount,
});

/** A request the way the app sends it, three lines of one piece by default. */
const request = (extra = {}) => {
  const lines = [gold(60000), gold(30000), gold(10000)];
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  return {
    customer_name: 'Walk-in',
    line_items: lines,
    subtotal,
    gst_rate: 3,
    gst_amount: subtotal * 0.03,
    grand_total: subtotal * 1.03,
    ...extra,
  };
};

const makeRes = () => ({
  statusCode: null,
  payload: null,
  finish(status, data) {
    this.statusCode = status;
    this.payload = data;
    return this;
  },
});

const OWNER = { businessId: '507f1f77bcf86cd799439011', userId: '507f1f77bcf86cd799439012', role: 'OWNER' };

const generate = async (body) => {
  const res = makeRes();
  await generateInvoice({ user: OWNER, body }, res, (err) => { throw err; });
  return res;
};

test('an invoice keeps how many pieces it bills: the one scanned piece unless the request says more', async () => {
  state.created = [];
  assert.equal((await generate(request())).statusCode, 201);
  assert.equal(state.created[0].pieceCount, 1, 'every invoice the app issues today bills one piece');

  assert.equal((await generate(request({ piece_count: 2 }))).statusCode, 201);
  assert.equal(state.created[1].pieceCount, 2);
});

test('a piece count that cannot be right is refused before an invoice number is spent', async () => {
  state.created = [];
  const numbersBefore = state.numbersTaken;
  for (const pieceCount of [0, -1, 1.5, 4, 'two']) {
    const res = await generate(request({ piece_count: pieceCount }));
    assert.equal(res.statusCode, 400, `piece_count ${pieceCount}`);
    assert.match(res.payload.message, /piece_count/);
  }
  assert.equal(state.numbersTaken, numbersBefore, 'no number was taken');
  assert.equal(state.created.length, 0);
});

test('the invoice list carries pieceCount (null when unknown), grand total and time, never the lines', async () => {
  const createdAt = new Date('2026-10-16T02:54:00Z');
  state.listed = [
    { _id: 'a', invoiceNumber: '26-27/1016/00002', grandTotal: 114131, pieceCount: 2, createdAt, publicToken: 'tok' },
    // Issued before the count was kept.
    { _id: 'b', invoiceNumber: '26-27/1015/00001', grandTotal: 82694, createdAt, publicToken: null },
  ];
  const res = makeRes();
  await getInvoices({ user: OWNER, query: {} }, res, (err) => { throw err; });

  assert.equal(res.statusCode, 200);
  assert.equal(state.listQuery.select, '-lineItems', 'the list never loads the lines');
  const [counted, legacy] = res.payload.invoices;
  assert.equal(counted.pieceCount, 2);
  assert.equal(counted.grandTotal, 114131);
  assert.equal(counted.createdAt, createdAt);
  assert.equal(counted.invoiceUrl, 'https://amitaash.com/api/v1/invoices/p/tok');
  assert.equal(legacy.pieceCount, null);
  assert.equal(legacy.invoiceNumber, '26-27/1015/00001');
});

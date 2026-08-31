/**
 * The invoice QR code points at GET /api/v1/invoices/p/:token, which has to be
 * reachable without a JWT. These tests pin that contract: the token is the only
 * credential, it is validated before any database lookup, and the PDF is
 * returned by our API rather than redirected to an expiring signed URL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const CONTROLLER = path.join(__dirname, '..', 'src', 'controllers', 'invoice.controller.js');
const CONTROLLER_DIR = path.dirname(CONTROLLER);

const state = {
  invoice: null,
  findOneQuery: null,
  cachedInvoice: null,
  cacheGets: [],
  cacheSets: [],
  freshUrlCalls: 0,
  freshUrlThrows: false,
  fetchedUrls: [],
  fetchStatus: 200,
  qrPayloads: [],
  generatedPdfPayloads: [],
};

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: CONTROLLER,
    filename: CONTROLLER,
    paths: Module._nodeModulePaths(CONTROLLER_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('../models/invoice.model', {
  findOne(query) {
    state.findOneQuery = query;
    return { select: () => ({ lean: async () => state.invoice }) };
  },
  create: async (doc) => doc,
  findByIdAndUpdate: async () => ({}),
});
stub('qrcode', {
  toDataURL: async (payload) => {
    state.qrPayloads.push(payload);
    return 'data:image/png;base64,qr';
  },
});
stub('../models/business.model', { findById: () => ({ lean: async () => null }) });
stub('../models/businessUser.model', { findById: () => ({ select: () => ({ lean: async () => null }) }) });
stub('../models/employee.model', { findById: () => ({ select: () => ({ lean: async () => null }) }) });
stub('../models/invoiceCounter.model', {
  generateInvoiceNumber: async () => '1/2026-27',
  peekNextInvoiceNumber: async () => '2/2026-27',
});
stub('../services/pdfmonkey.service', {
  generateInvoicePdf: async (payload) => {
    state.generatedPdfPayloads.push(payload);
    return { downloadUrl: 'https://pdf.test/new.pdf', docId: 'doc-1' };
  },
  getDownloadUrl: async () => {
    state.freshUrlCalls += 1;
    if (state.freshUrlThrows) throw new Error('pdfmonkey unavailable');
    return 'https://pdf.test/fresh.pdf';
  },
});
stub('../services/redis.service', {
  getInvoicePdfCache: async (token) => {
    state.cacheGets.push(token);
    return state.cachedInvoice;
  },
  setInvoicePdfCache: async (token, invoiceNumber, pdfBuffer) => {
    state.cacheSets.push({ token, invoiceNumber, pdfBuffer });
  },
});
stub('../config/env', {
  publicBaseUrl: 'https://amitaash.com',
  invoicePdfCache: { maxBytes: 15 * 1024 * 1024 },
});
stub('../utils/apiResponse', {
  sendSuccess: (res, data, status = 200) => res.finish(status, data),
  sendError: (res, message, status = 400) => res.finish(status, { message }),
});

const { generateInvoice, getPublicInvoice } = require(CONTROLLER);

const originalFetch = global.fetch;
global.fetch = async (url) => {
  state.fetchedUrls.push(url);
  if (state.fetchStatus !== 200) return { ok: false, status: state.fetchStatus, body: null };
  const bytes = new TextEncoder().encode('%PDF-1.4 stub');
  return {
    ok: true,
    status: 200,
    // Real fetch always exposes headers; the controller reads content-length.
    headers: new Headers({
      'content-type': 'application/pdf',
      'content-length': String(bytes.byteLength),
    }),
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
};
test.after(() => { global.fetch = originalFetch; });

/** Minimal res double that records what the handler did. */
const makeRes = () => {
  const chunks = [];
  return {
    statusCode: null,
    payload: null,
    headers: {},
    piped: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    finish(status, payload) { this.statusCode = status; this.payload = payload; },
    on() { return this; },
    once() { return this; },
    emit() { return this; },
    write(c) { chunks.push(c); return true; },
    end(c) {
      if (c) chunks.push(c);
      this.piped = true;
      this.body = Buffer.concat(chunks.map(Buffer.from)).toString();
    },
  };
};

const call = async (token, query) => {
  const res = makeRes();
  await getPublicInvoice({ params: { token }, query }, res, (err) => { throw err; });
  // The response is streamed, so wait a tick for the pipe to drain.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return res;
};

const VALID = 'a'.repeat(32);

const reset = () => {
  state.invoice = null;
  state.findOneQuery = null;
  state.cachedInvoice = null;
  state.cacheGets = [];
  state.cacheSets = [];
  state.freshUrlCalls = 0;
  state.freshUrlThrows = false;
  state.fetchedUrls = [];
  state.fetchStatus = 200;
  state.qrPayloads = [];
  state.generatedPdfPayloads = [];
};

test('a malformed token is rejected without querying the database', async () => {
  reset();
  for (const bad of ['', 'abc', 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), '../../etc/passwd']) {
    const res = await call(bad);
    assert.equal(res.statusCode, 404, `expected 404 for ${JSON.stringify(bad)}`);
  }
  assert.equal(state.findOneQuery, null, 'no database lookup should happen for a malformed token');
});

test('an unknown token returns 404', async () => {
  reset();
  state.invoice = null;
  const res = await call(VALID);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(state.findOneQuery, { publicToken: VALID });
});

test('a Redis cache hit downloads the PDF without MongoDB or PDFMonkey', async () => {
  reset();
  state.cachedInvoice = {
    invoiceNumber: '19/2026-27',
    pdfBuffer: Buffer.from('%PDF-1.4 cached'),
  };

  const res = await call(VALID, { download: '1' });

  assert.deepEqual(state.cacheGets, [VALID]);
  assert.equal(state.findOneQuery, null);
  assert.equal(state.freshUrlCalls, 0);
  assert.equal(state.fetchedUrls.length, 0);
  assert.match(res.headers['content-disposition'], /^attachment;/);
  assert.equal(res.body, '%PDF-1.4 cached');
});

test('an invoice whose PDF is not ready returns 409, not a broken download', async () => {
  reset();
  state.invoice = { invoiceNumber: '1/2026-27', pdfStatus: 'pending', pdfMonkeyDocId: 'doc-1' };
  const res = await call(VALID);
  assert.equal(res.statusCode, 409);
  assert.equal(state.fetchedUrls.length, 0);
});

test('a ready invoice serves the PDF using a freshly signed URL', async () => {
  reset();
  state.invoice = {
    invoiceNumber: '19/2026-27',
    pdfStatus: 'success',
    pdfMonkeyDocId: 'doc-1',
    pdfUrl: 'https://pdf.test/stale.pdf',
  };
  const res = await call(VALID);

  assert.equal(state.freshUrlCalls, 1, 'should refresh the expiring signed URL');
  assert.deepEqual(state.fetchedUrls, ['https://pdf.test/fresh.pdf'], 'must not use the stale stored URL');
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /^inline; filename="19-2026-27\.pdf"$/);
  assert.match(res.headers['cache-control'], /private/);
  assert.equal(state.cacheSets.length, 1, 'cache miss should be repopulated');
  assert.equal(state.cacheSets[0].invoiceNumber, '19/2026-27');
});

test('a filename with path characters cannot escape the Content-Disposition header', async () => {
  reset();
  state.invoice = {
    invoiceNumber: 'bad"/..\\name',
    pdfStatus: 'success',
    pdfMonkeyDocId: 'doc-1',
    pdfUrl: 'https://pdf.test/stale.pdf',
  };
  const res = await call(VALID);
  const disposition = res.headers['content-disposition'];
  assert.equal((disposition.match(/"/g) || []).length, 2, 'no injected quotes');
  assert.ok(!disposition.includes('/') && !disposition.includes('\\'), disposition);
});

test('it falls back to the stored URL when PDFMonkey cannot be reached', async () => {
  reset();
  state.freshUrlThrows = true;
  state.invoice = {
    invoiceNumber: '19/2026-27',
    pdfStatus: 'success',
    pdfMonkeyDocId: 'doc-1',
    pdfUrl: 'https://pdf.test/stored.pdf',
  };
  const res = await call(VALID);
  assert.deepEqual(state.fetchedUrls, ['https://pdf.test/stored.pdf']);
  assert.equal(res.headers['content-type'], 'application/pdf');
});

test('an invoice with no usable PDF URL returns 404 rather than fetching undefined', async () => {
  reset();
  state.freshUrlThrows = true;
  state.invoice = { invoiceNumber: '19/2026-27', pdfStatus: 'success', pdfMonkeyDocId: 'doc-1', pdfUrl: null };
  const res = await call(VALID);
  assert.equal(res.statusCode, 404);
  assert.equal(state.fetchedUrls.length, 0);
});

test('scanning the QR shows the invoice inline, and ?download=1 saves it', async () => {
  const ready = {
    invoiceNumber: '19/2026-27',
    pdfStatus: 'success',
    pdfMonkeyDocId: 'doc-1',
    pdfUrl: 'https://pdf.test/stored.pdf',
  };

  reset();
  state.invoice = ready;
  const viewed = await call(VALID);
  assert.match(viewed.headers['content-disposition'], /^inline;/);

  for (const flag of ['1', 'true', 'YES']) {
    reset();
    state.invoice = ready;
    const saved = await call(VALID, { download: flag });
    assert.match(
      saved.headers['content-disposition'],
      /^attachment; filename="19-2026-27\.pdf"$/,
      `download=${flag} should force a save`,
    );
  }

  // Anything else keeps the default viewing behaviour.
  reset();
  state.invoice = ready;
  const odd = await call(VALID, { download: 'maybe' });
  assert.match(odd.headers['content-disposition'], /^inline;/);
});

test('an upstream failure surfaces as 502, not a truncated PDF', async () => {
  reset();
  state.fetchStatus = 403;
  state.invoice = {
    invoiceNumber: '19/2026-27',
    pdfStatus: 'success',
    pdfMonkeyDocId: 'doc-1',
    pdfUrl: 'https://pdf.test/stored.pdf',
  };
  const res = await call(VALID);
  assert.equal(res.statusCode, 502);
});

test('the ordinary invoice QR requests a direct download and warms Redis', async () => {
  reset();
  const res = makeRes();

  await generateInvoice({
    user: { businessId: '507f1f77bcf86cd799439011' },
    body: {
      customer_name: 'Garg Jewellers',
      line_items: [{ description: '18KT GOLD', qty: 1, qty_unit: 'Gms.', price: 100, amount: 100 }],
      subtotal: 100,
      gst_rate: 3,
      gst_amount: 3,
      grand_total: 103,
    },
  }, res, (err) => { throw err; });

  assert.equal(res.statusCode, 201);
  assert.match(state.qrPayloads[0], /^https:\/\/amitaash\.com\/api\/v1\/invoices\/p\/[a-f0-9]{32}\?download=1$/);
  assert.equal(state.generatedPdfPayloads[0].qr_code_data, state.qrPayloads[0]);
  assert.ok(!res.payload.invoiceUrl.includes('?download=1'), 'app preview URL stays inline');
  assert.equal(state.cacheSets.length, 1, 'generated PDF should be cached before returning');
  assert.equal(state.cacheSets[0].token, res.payload.invoiceUrl.split('/').pop());
});

test('caller e-invoice data cannot replace the printed PDF download QR', async () => {
  reset();
  const res = makeRes();
  const signedIrpPayload = 'signed-government-e-invoice-payload';

  await generateInvoice({
    user: { businessId: '507f1f77bcf86cd799439011' },
    body: {
      customer_name: 'Garg Jewellers',
      line_items: [{ description: '18KT GOLD', qty: 1, qty_unit: 'Gms.', price: 100, amount: 100 }],
      subtotal: 100,
      gst_rate: 3,
      gst_amount: 3,
      grand_total: 103,
      irn: 'IRN-123',
      qr_code_data: signedIrpPayload,
    },
  }, res, (err) => { throw err; });

  const payload = state.generatedPdfPayloads[0];
  assert.match(state.qrPayloads[0], /\/api\/v1\/invoices\/p\/[a-f0-9]{32}\?download=1$/);
  assert.equal(payload.qr_code_data, state.qrPayloads[0]);
  assert.equal(payload.e_invoice_qr_code_data, signedIrpPayload);
  assert.notEqual(state.qrPayloads[0], signedIrpPayload);
});

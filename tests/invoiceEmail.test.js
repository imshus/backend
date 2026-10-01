/**
 * Email in the app sends the invoice PDF over the server's SMTP account, to
 * the customer email saved on the invoice and to no one else. These tests pin
 * that: the saved address is the only recipient, the PDF rides along as the
 * attachment, and every case the app falls back on (no SMTP, no address, PDF
 * not ready) is refused before anything is sent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const CONTROLLER = path.join(__dirname, '..', 'src', 'controllers', 'invoice.controller.js');
const CONTROLLER_DIR = path.dirname(CONTROLLER);
const MAIL_SERVICE = path.join(__dirname, '..', 'src', 'services', 'mail.service.js');

const PDF = Buffer.from('%PDF-1.4 stub');

const state = {};
const reset = (invoice = {}) => {
  Object.assign(state, {
    invoice: {
      _id: 'inv-1',
      invoiceNumber: '12/2026-27',
      invoiceDate: '01-10-2026',
      companyName: 'Shree Jewellers',
      customerName: 'Ravi',
      customerEmail: 'ravi@example.com',
      grandTotal: 152345.5,
      pdfStatus: 'success',
      pdfUrl: 'https://pdf.test/stored.pdf',
      pdfMonkeyDocId: 'doc-1',
      publicToken: 'a'.repeat(32),
      ...invoice,
    },
    findOneQuery: null,
    // What a re-read of the invoice returns while the PDF renders, in turn.
    polls: [],
    updates: [],
    cached: { pdfBuffer: PDF, invoiceNumber: '12/2026-27' },
    cacheSets: [],
    fetchedUrls: [],
    configured: true,
    sendThrows: false,
    sent: [],
  });
};
reset();

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
  findById: () => ({
    select: () => ({ lean: async () => state.polls.shift() || { pdfStatus: state.invoice.pdfStatus } }),
  }),
  findByIdAndUpdate: async (id, update) => { state.updates.push({ id, update }); },
});
stub('../models/business.model', { findById: () => ({ lean: async () => null }) });
stub('../models/businessUser.model', { findById: () => ({ select: () => ({ lean: async () => null }) }) });
stub('../models/employee.model', { findById: () => ({ select: () => ({ lean: async () => null }) }) });
stub('../models/invoiceCounter.model', {
  generateInvoiceNumber: async () => '1/2026-27',
  peekNextInvoiceNumber: async () => '2/2026-27',
});
stub('../services/pdfmonkey.service', {
  generateInvoicePdf: async () => ({ downloadUrl: '', docId: '' }),
  getDownloadUrl: async () => 'https://pdf.test/fresh.pdf',
});
stub('../services/redis.service', {
  getInvoicePdfCache: async () => state.cached,
  setInvoicePdfCache: async (token, invoiceNumber, pdfBuffer) => {
    state.cacheSets.push({ token, invoiceNumber, pdfBuffer });
  },
});
stub('../services/mail.service', {
  isConfigured: () => state.configured,
  sendMail: async (message) => {
    if (state.sendThrows) throw new Error('535 authentication failed');
    state.sent.push(message);
    return { messageId: '<1@test>' };
  },
});
stub('../config/env', {
  publicBaseUrl: 'https://amitaash.com',
  invoicePdfCache: { maxBytes: 15 * 1024 * 1024 },
  invoiceEmailPdfWaitMs: 1000,
});
stub('../utils/apiResponse', {
  sendSuccess: (res, data, status = 200) => res.finish(status, data),
  sendError: (res, message, status = 400) => res.finish(status, { message }),
});

const { emailInvoice } = require(CONTROLLER);

const originalFetch = global.fetch;
global.fetch = async (url) => {
  state.fetchedUrls.push(url);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(PDF.length) }),
    arrayBuffer: async () => PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.length),
  };
};
test.after(() => { global.fetch = originalFetch; });

const call = async (user = { businessId: 'biz-1', userId: 'owner-1', role: 'OWNER' }) => {
  const res = { statusCode: null, payload: null, finish(status, payload) { this.statusCode = status; this.payload = payload; } };
  await emailInvoice({ params: { id: 'inv-1' }, user }, res, (err) => { throw err; });
  return res;
};

test('emails the PDF to the customer email saved on the invoice', async () => {
  reset();
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { sentTo: 'ravi@example.com' });
  assert.equal(state.sent.length, 1);
  const [message] = state.sent;
  assert.equal(message.to, 'ravi@example.com');
  assert.equal(message.fromName, 'Shree Jewellers');
  assert.equal(message.subject, 'Invoice 12/2026-27 from Shree Jewellers');
  assert.match(message.text, /Dear Ravi,/);
  assert.match(message.text, /₹ 1,52,345\.50/);
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].contentType, 'application/pdf');
  assert.equal(message.attachments[0].filename, '12-2026-27.pdf');
  assert.ok(message.attachments[0].content.equals(PDF));
  assert.equal(state.updates[0].update.emailedTo, 'ravi@example.com');
  // Scoped like every other invoice read: this business only.
  assert.equal(state.findOneQuery.businessId, 'biz-1');
});

test('an employee can only email their own invoices', async () => {
  reset();
  await call({ businessId: 'biz-1', userId: 'emp-7', role: 'EMP' });
  assert.equal(state.findOneQuery.userId, 'emp-7');
});

test('without a saved customer email nothing is sent', async () => {
  for (const customerEmail of ['', '   ', 'not-an-email', 'a@b.com, c@d.com', 'x@y.com\r\nBcc: z@q.com']) {
    reset({ customerEmail });
    const res = await call();
    assert.equal(res.statusCode, 400, customerEmail);
    assert.equal(state.sent.length, 0);
  }
});

test('503 while SMTP is not set up, so the app opens the mail app instead', async () => {
  reset();
  state.configured = false;
  const res = await call();
  assert.equal(res.statusCode, 503);
  assert.equal(state.sent.length, 0);
});

test('an Email tapped while the PDF renders waits for it, then sends', async () => {
  reset({ pdfStatus: 'pending' });
  state.polls = [{ pdfStatus: 'pending' }, { pdfStatus: 'success', pdfUrl: 'https://pdf.test/new.pdf', pdfMonkeyDocId: 'doc-2' }];
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(state.sent.length, 1);
});

test('a PDF still rendering after the wait, or failed, is not sent', async () => {
  reset({ pdfStatus: 'pending' });
  assert.equal((await call()).statusCode, 409);
  reset({ pdfStatus: 'failure' });
  assert.equal((await call()).statusCode, 502);
  assert.equal(state.sent.length, 0);
});

test('a PDF not in Redis is downloaded fresh and cached for the QR code', async () => {
  reset();
  state.cached = null;
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.fetchedUrls, ['https://pdf.test/fresh.pdf']);
  assert.equal(state.cacheSets[0].token, 'a'.repeat(32));
  assert.ok(state.sent[0].attachments[0].content.equals(PDF));
});

test('an SMTP failure is reported and not recorded as sent', async () => {
  reset();
  state.sendThrows = true;
  const res = await call();
  assert.equal(res.statusCode, 502);
  assert.equal(state.updates.length, 0);
});

test('mail goes out from SMTP_FROM under the shop name, header-safe', () => {
  const resolved = require.resolve('../src/config/env');
  const saved = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: { smtp: { host: 'smtp.test', port: 465, secure: true, from: 'invoices@mrpscan.com' } },
  };
  delete require.cache[MAIL_SERVICE];
  try {
    const mail = require(MAIL_SERVICE);
    assert.equal(mail.isConfigured(), true);
    const built = mail.buildMessage({
      to: 'ravi@example.com',
      subject: 's',
      text: 't',
      fromName: 'Shree "Gold" <Jewellers>\r\nBcc: x@y.com',
    });
    assert.deepEqual(built.from, { name: 'Shree Gold Jewellers Bcc: x@y.com', address: 'invoices@mrpscan.com' });
    assert.equal(mail.buildMessage({ to: 'a@b.co', subject: 's', text: 't' }).from, 'invoices@mrpscan.com');
  } finally {
    delete require.cache[MAIL_SERVICE];
    if (saved) require.cache[resolved] = saved;
    else delete require.cache[resolved];
  }
});

test('SMTP is off until both a host and a sender are set', () => {
  const resolved = require.resolve('../src/config/env');
  const saved = require.cache[resolved];
  try {
    for (const smtp of [{}, { host: 'smtp.test' }, { from: 'a@b.co' }, { host: ' ', from: 'a@b.co' }]) {
      require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { smtp } };
      delete require.cache[MAIL_SERVICE];
      assert.equal(require(MAIL_SERVICE).isConfigured(), false, JSON.stringify(smtp));
    }
  } finally {
    delete require.cache[MAIL_SERVICE];
    if (saved) require.cache[resolved] = saved;
    else delete require.cache[resolved];
  }
});

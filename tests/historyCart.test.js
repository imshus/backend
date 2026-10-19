/**
 * Settings -> History, from the start of a scan, and the cart invoice.
 *
 *   - Tag scan history: POST /scans/:scanId/analyze starts the scan's line
 *     the moment the tag is read (status 'read', the reading's price or null,
 *     and everything read in `details`); POST /scans/:scanId/calculate
 *     prices it (status 'priced', `pricing`: the inputs and the workings),
 *     keeping the time it was read. GET /history/scans pages the lines
 *     (cursor on createdAt + _id) and GET /history/scans/:scanId opens one.
 *   - Wishlist history: POST /wishlist copies the item it adds into
 *     wishlist_history, which removing or clearing the wishlist never
 *     touches. GET /history/wishlist and /history/wishlist/:id.
 *   - Cart invoices: POST /invoices/generate (and preview-html) take a cart's
 *     `pieces`; the invoice keeps them, and GET /history/checkouts and
 *     /history/checkouts/:id list and open them.
 * The owner sees the shop's lines, an employee their own.
 *
 * Runs against a real (in-memory) MongoDB with the real controllers. The
 * model's reading, the live gold rate, the scan session and the PDF service
 * are stood in for; no paid API is reached and nothing is sent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Independent of the developer's .env (dotenv never overrides these).
process.env.NODE_ENV = 'test';
process.env.USE_MEMORY_STORE = 'true';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.MSG91_AUTH_KEY = 'test';
process.env.MSG91_TEMPLATE_ID = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.SANDBOX_API_KEY = 'test';
process.env.SANDBOX_API_SECRET = 'test';
process.env.PUBLIC_BASE_URL = 'https://api.example.test';
process.env.SCAN_STORE = 'memory';

const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// The PDF service is stood in for before the invoice controller takes its
// functions from it.
const pdfmonkey = require('../src/services/pdfmonkey.service');
pdfmonkey.generateInvoicePdf = async () => ({ downloadUrl: '', docId: '' });
pdfmonkey.getDownloadUrl = async () => '';
const einvoiceService = require('../src/services/einvoice.service');
einvoiceService.isEligible = () => false;

const Business = require('../src/models/business.model');
const BusinessUser = require('../src/models/businessUser.model');
const Employee = require('../src/models/employee.model');
const ItemCode = require('../src/models/itemCode.model');
const Invoice = require('../src/models/invoice.model');
const Wishlist = require('../src/models/wishlist.model');
const ScanHistory = require('../src/models/scanHistory.model');
const WishlistHistory = require('../src/models/wishlistHistory.model');
const authService = require('../src/services/auth.service');
const rateCalculationService = require('../src/services/rateCalculation.service');
const redisService = require('../src/services/redis.service');
const scanService = require('../src/services/scan.service');
const scanHistory = require('../src/services/scanHistory.service');
const wishlistHistory = require('../src/services/wishlistHistory.service');
const checkoutHistory = require('../src/services/checkoutHistory.service');
const accountDeletionService = require('../src/services/accountDeletion.service');
const scanController = require('../src/controllers/scan.controller');
const calculationController = require('../src/controllers/calculation.controller');
const invoiceController = require('../src/controllers/invoice.controller');
const { authenticateJWT } = require('../src/middleware/auth.middleware');
const errorHandler = require('../src/middleware/errorHandler');

// The board: 24K at Rs 1,30,000 (RTGS) / 1,29,000 (cash) per 10 g, unless a
// test takes the live rate away.
const board = { live: true };
rateCalculationService.getLiveGoldRates = async () => (board.live
  ? {
    karatRates: [{ carat: '22K', purity: 91.6 }, { carat: '18K', purity: 75 }],
    taxSettings: { rtgsFinalRate: 130000, cashFinalRate: 129000 },
    supremeChanges: { rtgsChange: 0, cashChange: 0 },
  }
  : { karatRates: [], taxSettings: {} });

// The scan sessions, as Redis (or the in-memory store) would hold them.
const scans = new Map();
redisService.getScan = async (scanId) => scans.get(scanId) || null;
redisService.updateScanStatus = async (scanId, status, extra) => ({ scanId, status, ...extra });
redisService.finishLatestAnalyzedScan = async () => false;
redisService.setInvoicePdfCache = async () => {};
redisService.claimInvoiceToken = async () => false;

let mongoServer;
let server;
let baseUrl;

const shop = { id: new mongoose.Types.ObjectId() };
const otherShop = { id: new mongoose.Types.ObjectId() };
const people = {};

const tokenOf = (who) => authService.generateTokens(String(who.businessId), String(who.userId), who.role).accessToken;

async function api(method, path, { as, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(as ? { authorization: `Bearer ${tokenOf(as)}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The scan's line once it says `until` (lines are written just after the answer). */
async function lineOf(scanId, until = () => true) {
  for (let tries = 0; tries < 150; tries += 1) {
    const line = await ScanHistory.findOne({ scanId }).lean();
    if (line && until(line)) return line;
    await sleep(20);
  }
  return ScanHistory.findOne({ scanId }).lean();
}

const field = (value, confidence = 95) => ({ value, confidence });
const empty = () => field('', 0);

/** A diamond tag's reading as the analysis returns it: every field a { value, confidence }. */
const readingOf = (serial) => ({
  provider: 'openai-test',
  rawText: { merged: `${serial}\nGR WT 10.500 NT WT 10.000\n22K 916\nLBR 850` },
  structuredData: {
    serialNumber: field(serial),
    packetCode: empty(),
    grossWeight: field('10.500'),
    netWeight: field('10.000'),
    purity: field('916'),
    karat: field('22K'),
    labour: field('LBR 850'),
    diamonds: [
      {
        shape: field('RD'), packetCode: field('P1'), weight: field('0.25'), unit: field('ct'),
        pieces: field('12'), rate: field('50000'), quality: field('VVS-EF'), color: field('EF'), clarity: field('VVS'),
      },
      // The reader's schema always carries a row; an empty one is no stone.
      {
        shape: empty(), packetCode: empty(), weight: empty(), unit: empty(),
        pieces: empty(), rate: empty(), quality: empty(), color: empty(), clarity: empty(),
      },
    ],
    colorstones: [
      {
        type: field('Ruby'), weight: field('0.10'), unit: field('ct'), pieces: field('3'),
        rate: field('2000'), quality: empty(), color: field('RED'), clarity: field('SI'),
      },
    ],
  },
  unknownFields: [],
  overallConfidence: 92,
});

/**
 * The analyze endpoint for a scan `who` owns: the model's reading stood in
 * for, the record kept where the calculate finds it.
 */
async function analyze(who, scanId, { serial = 'NK10432' } = {}) {
  const record = {
    scanId,
    ownerUserId: String(who.userId),
    businessId: String(who.businessId),
    status: 'ANALYSIS_COMPLETED',
    jewelleryType: 'DIAMOND',
    calculationMode: 'rtgs',
    analysisResult: readingOf(serial),
    billing: { billed: false },
  };
  scans.set(scanId, record);
  scanService.analyzeScan = async () => record;
  return api('POST', `/scans/${scanId}/analyze`, { as: who, body: {}, headers: { 'x-pricing-rules': '3' } });
}

const CARD = {
  jewelleryType: 'Diamond',
  purityKarat: '22K',
  netWt: 10,
  grossWt: 10.5,
  itemCode: 'NK10432',
  diamonds: [{ weight: 0.25, rate: 50000, discountPercent: 0, unit: 'ct' }],
  colorstones: [{ weight: 0.1, rate: 2000, unit: 'ct' }],
  labourChargeAmount: 850,
  labourChargeUnit: 'Per Gram',
  wastagePercent: 8,
  wastageWeightBasis: 'gross',
  otherCharges: 500,
  calculationMode: 'cash',
};

const calculate = (who, scanId, body = CARD) =>
  api('POST', `/scans/${scanId}/calculate`, { as: who, body, headers: { 'x-pricing-rules': '3' } });

test.before(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([ScanHistory.init(), WishlistHistory.init(), Invoice.init(), Wishlist.init()]);

  await Business.create({
    _id: shop.id,
    gstNumber: '27AAAAA0000A1Z5',
    legalName: 'SHREE JEWELLERS PVT LTD',
    tradeName: 'Shree Jewellers',
    businessType: 'Retailer',
    gstStatus: 'Active',
    address: '12 Zaveri Bazaar, Mumbai 400002',
    isRegistered: true,
  });
  const owner = await BusinessUser.create({
    businessId: shop.id, phone: '9000000011', passwordHash: 'x', mpinHash: 'x', role: 'OWNER',
  });
  const ravi = await Employee.create({ businessId: shop.id, name: 'Ravi', phone: '9811100011' });
  const sita = await Employee.create({ businessId: shop.id, name: 'Sita', phone: '9811100012' });
  const otherOwner = await BusinessUser.create({
    businessId: otherShop.id, phone: '9000000012', passwordHash: 'x', role: 'OWNER',
  });
  people.owner = { businessId: shop.id, userId: owner._id, role: 'OWNER' };
  people.ravi = { businessId: shop.id, userId: ravi._id, role: 'EMP' };
  people.sita = { businessId: shop.id, userId: sita._id, role: 'EMP' };
  people.otherOwner = { businessId: otherShop.id, userId: otherOwner._id, role: 'OWNER' };

  // Masters -> Item Code: NK is the shop's necklace; NK10432 is one of them.
  await ItemCode.create({ businessId: shop.id, code: 'NK', description: 'Gold Necklace' });

  const app = express();
  app.use(express.json());
  // The routes as scan.routes and invoice.routes mount them, without the
  // licence gates in front of the scan routes (scanAccess.test.js has those).
  app.post('/api/v1/scans/:scanId/analyze', authenticateJWT, scanController.analyzeScan);
  app.post('/api/v1/scans/:scanId/calculate', authenticateJWT, calculationController.calculateMRP);
  app.post('/api/v1/invoices/generate', authenticateJWT, invoiceController.generateInvoice);
  app.post('/api/v1/invoices/preview-html', authenticateJWT, invoiceController.previewInvoiceHtml);
  app.use('/api/v1/wishlist', require('../src/routes/wishlist.routes'));
  app.use('/api/v1/history', require('../src/routes/history.routes'));
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(async () => {
  // The invoice PDF renders in the background; let it settle first.
  await sleep(100);
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

// ── Tag scan history ──────────────────────────────────────────────────

test('reading a tag starts its line: status read, the reading price, and everything read', async () => {
  const read = await analyze(people.owner, 'scan-a1');
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const readPrice = read.body.data.pricing.finalMRPRounded;
  assert.ok(readPrice > 0);

  const line = await lineOf('scan-a1');
  assert.ok(line, 'the analysis wrote a line');
  assert.equal(line.status, 'read');
  assert.equal(line.userId, String(people.owner.userId));
  assert.equal(line.itemName, 'Gold Necklace', "the Masters item's name");
  assert.equal(line.tagCode, 'NK10432');
  assert.equal(line.karat, '22K');
  assert.equal(line.finalMRP, readPrice, 'the price the card opens with');
  assert.equal(line.pricing, null, 'no price asked for yet');
  assert.deepEqual(line.details, {
    jewelleryType: 'DIAMOND',
    grossWeight: '10.500',
    netWeight: '10.000',
    karat: '22K',
    purity: '916',
    serialNumber: 'NK10432',
    itemCode: 'NK',
    packetCode: '',
    tagIdentifiers: ['NK10432'],
    diamonds: [{
      weight: '0.25', unit: 'ct', pieces: '12', shape: 'RD', quality: 'VVS-EF',
      color: 'EF', clarity: 'VVS', rate: '50000', packetCode: 'P1',
    }],
    colorstones: [{
      type: 'Ruby', weight: '0.10', unit: 'ct', pieces: '3', shape: '', quality: '',
      color: 'RED', clarity: 'SI', rate: '2000', packetCode: '',
    }],
    labour: 'LBR 850',
    wastage: '',
    otherCharges: '',
    rawText: 'NK10432\nGR WT 10.500 NT WT 10.000\n22K 916\nLBR 850',
  });
});

test('pricing it makes the line priced, with the inputs and workings, and keeps when it was read', async () => {
  const before = await lineOf('scan-a1');
  const priced = await calculate(people.owner, 'scan-a1');
  assert.equal(priced.status, 200, JSON.stringify(priced.body));
  const { finalMRPRounded, breakdown } = priced.body.data;

  const line = await lineOf('scan-a1', (row) => row.status === 'priced');
  assert.equal(line.status, 'priced');
  assert.equal(line.finalMRP, finalMRPRounded);
  assert.equal(line.createdAt.getTime(), before.createdAt.getTime(), 'the time the tag was read');
  assert.deepEqual(line.details, before.details, 'what was read is kept');
  assert.equal(await ScanHistory.countDocuments({ scanId: 'scan-a1' }), 1);

  const { inputs, breakdown: kept, rules } = line.pricing;
  assert.equal(rules, 3);
  assert.deepEqual(inputs, {
    jewelleryType: 'Diamond',
    grossWt: 10.5,
    netWt: 10,
    purityKarat: '22K',
    customPurityPercent: null,
    calculationMode: 'cash',
    diamonds: [{ weight: 0.25, rate: 50000, discountPercent: 0, unit: 'ct' }],
    colorstones: [{ weight: 0.1, rate: 2000, unit: 'ct' }],
    labourChargeAmount: 850,
    labourChargeUnit: 'Per Gram',
    labourWeightBasis: null,
    labourCode: '',
    wastagePercent: 8,
    wastageWeightBasis: 'gross',
    otherCharges: 500,
    itemCode: 'NK10432',
    tagIdentifiers: [],
  });
  // The breakdown the card was answered with, every figure of it.
  for (const [key, value] of Object.entries(breakdown)) {
    assert.deepEqual(kept[key], value, `breakdown.${key}`);
  }
  assert.equal(kept.goldRatePer10g, 129000, 'the cash rate it was priced on');
  assert.equal(kept.effectivePurityPercent, 91.6);
  assert.equal(kept.purityAdjustedGoldRatePerGram, 12900 * (91.6 / 100));
  assert.deepEqual(kept.diamondLineItems, [{ index: 1, weight: 0.25, rate: 50000, discountPercent: 0, amount: 12500 }]);
  assert.equal(kept.colorstoneLineItems.length, 1);
  assert.equal(kept.colorstoneLineItems[0].amount, 200);
  assert.equal(kept.labourRate, 850);
  assert.equal(kept.labourUnit, 'Per Gram');
  assert.equal(kept.labourAmount, 8500);
  assert.equal(kept.wastagePercent, 8);
  assert.equal(kept.wastageWeightBasis, 'gross');
  assert.equal(kept.wastageWeightGrams, 0.84);
  assert.equal(kept.otherCharges, 500);
  assert.equal(kept.finalMRPRounded, finalMRPRounded);
});

test('a reading with no live rate starts its line unpriced, still named by the Masters item', async () => {
  board.live = false;
  try {
    const read = await analyze(people.owner, 'scan-a2');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.pricing, null);
    assert.equal(read.body.data.pricingError.code, 'RATES_UNAVAILABLE');
  } finally {
    board.live = true;
  }
  const line = await lineOf('scan-a2');
  assert.equal(line.status, 'read');
  assert.equal(line.finalMRP, null);
  assert.equal(line.itemName, 'Gold Necklace');
  assert.equal(line.details.itemCode, 'NK');

  // A tag no Masters item names is "<karat> <type>".
  board.live = false;
  try {
    assert.equal((await analyze(people.owner, 'scan-a3', { serial: 'ZZ-9' })).status, 200);
  } finally {
    board.live = true;
  }
  const unnamed = await lineOf('scan-a3');
  assert.equal(unnamed.itemName, '22K Diamond Jewellery');
  assert.equal(unnamed.tagCode, 'ZZ-9');
  assert.equal(unnamed.details.itemCode, '');
});

test('a price that lands before the reading keeps its line; the reading only adds what was read', async () => {
  const entry = { user: people.sita, scanId: 'scan-race', itemName: 'Gold Necklace', karat: '22K', tagCode: 'NK1' };
  assert.equal(await scanHistory.recordPricedScan({ ...entry, finalMRP: 5000, pricing: { inputs: {} }, mayCreate: true }), true);
  const priced = await ScanHistory.findOne({ scanId: 'scan-race' }).lean();

  const details = { grossWeight: '1.000' };
  assert.equal(await scanHistory.recordReadScan({ ...entry, itemName: '22K Gold', finalMRP: 4000, details }), true);
  const line = await ScanHistory.findOne({ scanId: 'scan-race' }).lean();
  assert.equal(line.status, 'priced');
  assert.equal(line.finalMRP, 5000, "the card's price stays");
  assert.equal(line.itemName, 'Gold Necklace');
  assert.deepEqual(line.pricing, { inputs: {} });
  assert.deepEqual(line.details, details, 'what was read is added');
  assert.equal(line.createdAt.getTime(), priced.createdAt.getTime());

  // A line still at 'read' (the same scan read again) takes the new reading.
  const again = { user: people.sita, scanId: 'scan-reread', karat: '22K', tagCode: '' };
  await scanHistory.recordReadScan({ ...again, itemName: '22K Gold', finalMRP: null, details: { n: 1 } });
  await scanHistory.recordReadScan({ ...again, itemName: 'Gold Necklace', finalMRP: 900, details: { n: 2 } });
  const reread = await ScanHistory.findOne({ scanId: 'scan-reread' }).lean();
  assert.deepEqual([reread.status, reread.itemName, reread.finalMRP, reread.details], ['read', 'Gold Necklace', 900, { n: 2 }]);
  assert.equal(await ScanHistory.countDocuments({ scanId: 'scan-reread' }), 1);

  // Another account's line for the id is never touched.
  assert.equal(await scanHistory.recordReadScan({ ...again, user: people.ravi, finalMRP: 1, details: { n: 3 } }), false);
  assert.deepEqual((await ScanHistory.findOne({ scanId: 'scan-reread' }).lean()).details, { n: 2 });
});

test('a history write that fails never fails the reading', async () => {
  const originalUpdateOne = ScanHistory.updateOne;
  let attempted;
  const writeAttempted = new Promise((resolve) => { attempted = resolve; });
  ScanHistory.updateOne = async () => {
    attempted();
    throw new Error('disk full');
  };
  try {
    const read = await analyze(people.owner, 'scan-broken');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok(read.body.data.pricing.finalMRPRounded > 0, 'the reading and its price are answered as ever');
    await writeAttempted;
  } finally {
    ScanHistory.updateOne = originalUpdateOne;
  }
  assert.equal(await ScanHistory.countDocuments({ scanId: 'scan-broken' }), 0);
});

test('GET /history/scans pages newest first by cursor; the owner sees the shop, an employee their own', async () => {
  assert.equal((await analyze(people.ravi, 'scan-ravi-1')).status, 200);
  await lineOf('scan-ravi-1');
  assert.equal((await analyze(people.sita, 'scan-sita-1')).status, 200);
  await lineOf('scan-sita-1');

  const first = await api('GET', '/history/scans?limit=2', { as: people.owner });
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body.data).sort(), ['items', 'nextCursor']);
  assert.deepEqual(
    Object.keys(first.body.data.items[0]).sort(),
    ['createdAt', 'finalMRP', 'id', 'itemName', 'scanId', 'status', 'tagCode'],
  );
  assert.equal(typeof first.body.data.nextCursor, 'string');

  // Every page, newest first, each line once.
  const seen = [];
  let before = null;
  do {
    const query = before ? `?limit=2&before=${encodeURIComponent(before)}` : '?limit=2';
    const page = await api('GET', `/history/scans${query}`, { as: people.owner });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.ok(page.body.data.items.length <= 2);
    seen.push(...page.body.data.items);
    before = page.body.data.nextCursor;
  } while (before);
  const all = await ScanHistory.find({ businessId: shop.id }).sort({ createdAt: -1, _id: -1 }).lean();
  assert.deepEqual(seen.map((item) => item.scanId), all.map((line) => line.scanId));
  assert.ok(seen.some((item) => item.status === 'read') && seen.some((item) => item.status === 'priced'));

  const scanIdsOf = async (who) => (await api('GET', '/history/scans', { as: who })).body.data.items.map((item) => item.scanId);
  assert.deepEqual(await scanIdsOf(people.ravi), ['scan-ravi-1']);
  assert.deepEqual(await scanIdsOf(people.sita), ['scan-sita-1', 'scan-reread', 'scan-race']);
  assert.deepEqual(await scanIdsOf(people.otherOwner), []);

  const bad = await api('GET', '/history/scans?before=not-a-cursor', { as: people.owner });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'INVALID_CURSOR');
  assert.equal((await api('GET', '/history/scans')).status, 401, 'signed out');
});

test('GET /history/scans/:scanId opens one scan whole, for whoever may see it', async () => {
  const open = await api('GET', '/history/scans/scan-a1', { as: people.owner });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const { item } = open.body.data;
  assert.deepEqual(
    Object.keys(item).sort(),
    ['createdAt', 'details', 'finalMRP', 'id', 'itemName', 'pricing', 'scanId', 'status', 'tagCode', 'updatedAt'],
  );
  assert.equal(item.status, 'priced');
  assert.equal(item.details.serialNumber, 'NK10432');
  assert.equal(item.pricing.inputs.calculationMode, 'cash');

  const unpriced = (await api('GET', '/history/scans/scan-a2', { as: people.owner })).body.data.item;
  assert.equal(unpriced.status, 'read');
  assert.equal(unpriced.finalMRP, null);
  assert.equal(unpriced.pricing, null);

  assert.equal((await api('GET', '/history/scans/scan-ravi-1', { as: people.owner })).status, 200, "the owner sees an employee's");
  assert.equal((await api('GET', '/history/scans/scan-ravi-1', { as: people.ravi })).status, 200);
  assert.equal((await api('GET', '/history/scans/scan-ravi-1', { as: people.sita })).status, 404, "never a colleague's");
  assert.equal((await api('GET', '/history/scans/scan-a1', { as: people.otherOwner })).status, 404, "never another shop's");
  assert.equal((await api('GET', '/history/scans/no-such-scan', { as: people.owner })).status, 404);
});

// ── Wishlist history ──────────────────────────────────────────────────

/** A wishlist item as the app posts it. */
const wishlistItem = (itemId, extra = {}) => ({
  itemId,
  title: 'Diamond',
  tagCode: 'NK10432',
  totalMrp: 82694,
  priceBadge: '₹ 82,694',
  calculationRate: 'rtgs',
  scanTimestamp: '2026-10-17T05:00:00.000Z',
  snapshot: {
    scanData: { itemName: 'Gold Necklace', karat: '22K', sku: 'NK10432' },
    selectedType: 'Diamond',
    pricing: { ultimateMrp: 82694 },
    ultimateMrp: 82694,
  },
  ...extra,
});

test('adding to a wishlist copies the item into its history, once, kept after the wishlist is cleared', async () => {
  const added = await api('POST', '/wishlist', { as: people.ravi, body: wishlistItem('wl-1', { scanId: 'scan-ravi-1' }) });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.data.item.itemId, 'wl-1', 'the wishlist answer is as before');

  const line = await WishlistHistory.findOne({ wishlistItemId: 'wl-1' }).lean();
  assert.ok(line, 'written before the add answered');
  assert.equal(String(line.businessId), String(shop.id));
  assert.equal(line.userId, String(people.ravi.userId));
  assert.equal(line.scanId, 'scan-ravi-1');
  assert.equal(line.itemName, 'Gold Necklace');
  assert.equal(line.tagCode, 'NK10432');
  assert.equal(line.mrp, 82694);
  assert.equal(line.priceBadge, '₹ 82,694');
  assert.deepEqual(line.snapshot, wishlistItem('wl-1').snapshot);

  // A repeated tap adds no second line.
  assert.equal((await api('POST', '/wishlist', { as: people.ravi, body: wishlistItem('wl-1') })).status, 200);
  assert.equal(await WishlistHistory.countDocuments({ wishlistItemId: 'wl-1' }), 1);

  // Without a Masters name the line is "<karat> <type>"; a name sent wins.
  const plain = wishlistItem('wl-2', { snapshot: { scanData: { itemName: '', karat: '18KT' }, selectedType: 'Gold' } });
  assert.equal((await api('POST', '/wishlist', { as: people.ravi, body: plain })).status, 200);
  assert.equal((await WishlistHistory.findOne({ wishlistItemId: 'wl-2' }).lean()).itemName, '18K Gold');
  const named = wishlistItem('wl-3', { itemName: 'Bridal Set' });
  assert.equal((await api('POST', '/wishlist', { as: people.sita, body: named })).status, 200);
  const sitaLine = await WishlistHistory.findOne({ wishlistItemId: 'wl-3' }).lean();
  assert.equal(sitaLine.itemName, 'Bridal Set');
  assert.equal(sitaLine.scanId, '');

  // Removing one item, and clearing the list, leave the history be.
  assert.equal((await api('DELETE', '/wishlist/wl-1', { as: people.ravi })).status, 200);
  assert.equal((await api('DELETE', '/wishlist', { as: people.owner })).status, 200);
  assert.equal(await Wishlist.countDocuments({ businessId: shop.id }), 0);
  assert.equal(await WishlistHistory.countDocuments({ businessId: shop.id }), 3);
});

test('GET /history/wishlist lists and opens the lines for whoever may see them', async () => {
  const list = await api('GET', '/history/wishlist', { as: people.owner });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.data.nextCursor, null);
  const { items } = list.body.data;
  assert.deepEqual(items.map((item) => item.itemName), ['Bridal Set', '18K Gold', 'Gold Necklace'], 'newest first');
  assert.deepEqual(Object.keys(items[0]).sort(), ['createdAt', 'id', 'itemName', 'mrp', 'tagCode']);
  assert.equal(items[2].mrp, 82694);

  const ravis = (await api('GET', '/history/wishlist', { as: people.ravi })).body.data.items;
  assert.deepEqual(ravis.map((item) => item.itemName), ['18K Gold', 'Gold Necklace']);
  assert.deepEqual((await api('GET', '/history/wishlist', { as: people.otherOwner })).body.data.items, []);

  const paged = await api('GET', '/history/wishlist?limit=1', { as: people.ravi });
  assert.equal(paged.body.data.items.length, 1);
  const rest = await api('GET', `/history/wishlist?limit=1&before=${encodeURIComponent(paged.body.data.nextCursor)}`, { as: people.ravi });
  assert.deepEqual(rest.body.data.items.map((item) => item.itemName), ['Gold Necklace']);
  assert.equal(rest.body.data.nextCursor, null);

  const id = items[2].id;
  const open = await api('GET', `/history/wishlist/${id}`, { as: people.ravi });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const { item } = open.body.data;
  assert.equal(item.id, id);
  assert.equal(item.wishlistItemId, 'wl-1');
  assert.equal(item.scanId, 'scan-ravi-1');
  assert.equal(item.mrp, 82694);
  assert.equal(item.calculationRate, 'rtgs');
  assert.deepEqual(item.snapshot, wishlistItem('wl-1').snapshot);

  assert.equal((await api('GET', `/history/wishlist/${id}`, { as: people.owner })).status, 200);
  assert.equal((await api('GET', `/history/wishlist/${id}`, { as: people.sita })).status, 404, "never a colleague's");
  assert.equal((await api('GET', `/history/wishlist/${id}`, { as: people.otherOwner })).status, 404);
  assert.equal((await api('GET', '/history/wishlist/not-an-id', { as: people.owner })).status, 404);
});

test('a wishlist history write that fails never fails the add', async () => {
  const originalUpdateOne = WishlistHistory.updateOne;
  WishlistHistory.updateOne = async () => { throw new Error('disk full'); };
  try {
    const added = await api('POST', '/wishlist', { as: people.sita, body: wishlistItem('wl-broken') });
    assert.equal(added.status, 200, JSON.stringify(added.body));
  } finally {
    WishlistHistory.updateOne = originalUpdateOne;
  }
  assert.equal(await Wishlist.countDocuments({ itemId: 'wl-broken' }), 1);
  assert.equal(await WishlistHistory.countDocuments({ wishlistItemId: 'wl-broken' }), 0);
});

// ── Cart invoices and Checkout history ────────────────────────────────

const goldLine = (amount) => ({
  description: 'Gold (in grams)', qty: 10, qty_unit: 'Gms.', hsn: '71131913', price: amount / 10, amount,
});

/** An invoice request with these lines (two per piece below), totals the app would send. */
const invoiceBody = (extra = {}, amounts = [60000, 22694, 25000, 6437]) => {
  const lines = amounts.map(goldLine);
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const gst = Math.round(subtotal * 3) / 100;
  return {
    customer_name: 'Meera Shah',
    line_items: lines,
    subtotal,
    gst_rate: 3,
    gst_amount: gst,
    grand_total: Math.round(subtotal + gst),
    ...extra,
  };
};

const CART = [
  { wishlist_item_id: 'wl-1', scan_id: 'scan-ravi-1', item_name: '22K Gold Necklace', tag_code: 'TAG-10432', mrp: 82694 },
  { item_name: '18K Diamond Ring', tag_code: 'TAG-20117', mrp: 31437 },
];

test('a cart invoice bills every piece once and keeps them; its count is theirs', async () => {
  const made = await api('POST', '/invoices/generate', { as: people.ravi, body: invoiceBody({ pieces: CART }) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const invoice = await Invoice.findById(made.body.data.invoiceId).lean();
  assert.equal(invoice.pieceCount, 2);
  assert.deepEqual(invoice.pieces, [
    { itemName: '22K Gold Necklace', tagCode: 'TAG-10432', mrp: 82694, wishlistItemId: 'wl-1', scanId: 'scan-ravi-1' },
    { itemName: '18K Diamond Ring', tagCode: 'TAG-20117', mrp: 31437, wishlistItemId: '', scanId: '' },
  ]);
  assert.equal(invoice.grandTotal, made.body.data.grandTotal, "the lines' total, as for every invoice");

  const counted = await api('POST', '/invoices/generate', { as: people.owner, body: invoiceBody({ pieces: CART, piece_count: 2 }) });
  assert.equal(counted.status, 201, JSON.stringify(counted.body));

  // Billed straight from the card: no pieces, one piece counted.
  const single = await api('POST', '/invoices/generate', { as: people.owner, body: invoiceBody({}, [60000]) });
  assert.equal(single.status, 201, JSON.stringify(single.body));
  const plain = await Invoice.findById(single.body.data.invoiceId).lean();
  assert.equal(plain.pieceCount, 1);
  assert.equal(plain.pieces, undefined);
  assert.equal(plain.fromCart, undefined, 'not a Wishlist cart');
  assert.equal((await Invoice.findById(made.body.data.invoiceId).lean()).fromCart, true);
});

test('a cart that cannot be right is refused before an invoice number is spent, and so is its preview', async () => {
  const before = await Invoice.countDocuments({ businessId: shop.id });
  const piece = { item_name: 'Ring', tag_code: 'T-1', mrp: 1000 };
  const refusals = [
    [{ pieces: [] }, /pieces must be a list of 1 to 50/],
    [{ pieces: 'two' }, /pieces must be a list/],
    [{ pieces: Array.from({ length: 51 }, () => piece) }, /1 to 50/],
    [{ pieces: [piece, piece, piece, piece, piece] }, /more than the line items/],
    [{ pieces: CART, piece_count: 3 }, /piece_count must equal the number of pieces/],
    [{ pieces: [{ ...piece, item_name: ' ' }] }, /pieces\[0\]\.item_name is required/],
    [{ pieces: [{ ...piece, mrp: -1 }] }, /pieces\[0\]\.mrp/],
    [{ pieces: [{ ...piece, mrp: 'lots' }] }, /pieces\[0\]\.mrp/],
    [{ pieces: [piece, { ...piece, tag_code: { x: 1 } }] }, /pieces\[1\]\.tag_code must be text/],
    [{ pieces: [null] }, /pieces\[0\] must be an object/],
  ];
  for (const [extra, message] of refusals) {
    const refused = await api('POST', '/invoices/generate', { as: people.owner, body: invoiceBody(extra) });
    assert.equal(refused.status, 400, JSON.stringify(extra).slice(0, 80));
    assert.match(refused.body.error, message);
    const preview = await api('POST', '/invoices/preview-html', { as: people.owner, body: invoiceBody(extra) });
    assert.equal(preview.status, 400, `preview: ${JSON.stringify(extra).slice(0, 80)}`);
    assert.match(preview.body.error, message);
  }
  assert.equal(await Invoice.countDocuments({ businessId: shop.id }), before, 'no invoice made');

  const preview = await api('POST', '/invoices/preview-html', { as: people.owner, body: invoiceBody({ pieces: CART }) });
  assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 200));
  assert.match(preview.body.data.html, /Meera Shah/);
});

test('GET /history/checkouts lists only the Wishlist carts, newest first', async () => {
  // Issued before pieces (and before the count) were kept.
  const legacy = await Invoice.create({
    businessId: shop.id,
    invoiceNumber: '26-27/1001/00001',
    userId: String(people.owner.userId),
    invoiceDate: '01-10-2026',
    subtotal: 1000,
    gstRate: 3,
    gstAmount: 30,
    grandTotal: 1030,
    createdAt: new Date('2026-10-01T05:00:00Z'),
  });

  const list = await api('GET', '/history/checkouts', { as: people.owner });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const { items, nextCursor } = list.body.data;
  assert.equal(nextCursor, null);
  // The single-scan invoice and the one from before carts are not checkouts.
  assert.equal(items.length, 2);
  assert.deepEqual(
    Object.keys(items[0]).sort(),
    ['createdAt', 'grandTotal', 'id', 'invoiceNumber', 'pieceCount', 'pieces'],
  );
  const [counted, cart] = items;
  assert.equal(counted.pieceCount, 2);
  assert.equal(cart.pieceCount, 2);
  assert.deepEqual(cart.pieces, [
    { itemName: '22K Gold Necklace', tagCode: 'TAG-10432', mrp: 82694 },
    { itemName: '18K Diamond Ring', tagCode: 'TAG-20117', mrp: 31437 },
  ]);
  assert.ok(!items.some((item) => item.id === String(legacy._id)));

  // An employee sees their own; paging by cursor.
  const ravis = (await api('GET', '/history/checkouts', { as: people.ravi })).body.data.items;
  assert.deepEqual(ravis.map((item) => item.id), [cart.id]);
  assert.deepEqual((await api('GET', '/history/checkouts', { as: people.sita })).body.data.items, []);
  const page = await api('GET', '/history/checkouts?limit=1', { as: people.owner });
  assert.deepEqual(page.body.data.items.map((item) => item.id), [counted.id]);
  const last = await api('GET', `/history/checkouts?limit=1&before=${encodeURIComponent(page.body.data.nextCursor)}`, { as: people.owner });
  assert.deepEqual(last.body.data.items.map((item) => item.id), [cart.id]);
  assert.equal(last.body.data.nextCursor, null);
});

test('a cart billed before fromCart was kept is marked at startup and listed', async () => {
  const { markCartInvoices } = require('../src/services/userScope.service');
  const old = await Invoice.create({
    businessId: shop.id,
    invoiceNumber: '26-27/1016/00009',
    userId: String(people.owner.userId),
    invoiceDate: '16-10-2026',
    subtotal: 1000,
    gstRate: 3,
    gstAmount: 30,
    grandTotal: 1030,
    pieceCount: 1,
    pieces: [{ itemName: 'Old Cart Ring', tagCode: 'OC-1', mrp: 1000 }],
    // Unique, as every invoice's is (a sparse unique index; null counts).
    publicToken: 'oldcart0000000000000000000000001',
    createdAt: new Date('2026-10-02T05:00:00Z'),
  });
  const listed = async () => (await api('GET', '/history/checkouts', { as: people.owner })).body.data.items.map((item) => item.id);
  assert.ok(!(await listed()).includes(String(old._id)), 'unmarked, it is not listed');
  await markCartInvoices();
  assert.equal((await Invoice.findById(old._id).lean()).fromCart, true);
  assert.equal((await listed()).at(-1), String(old._id), 'listed, oldest last');
  // Nothing else changes, and a second run finds nothing to do.
  assert.equal(await Invoice.countDocuments({ pieces: { $exists: false }, fromCart: true }), 0);
  await markCartInvoices();
  await Invoice.deleteOne({ _id: old._id });
});

test('GET /history/checkouts/:id opens a cart with its customer, for whoever may see it', async () => {
  const [, cart] = (await api('GET', '/history/checkouts', { as: people.owner })).body.data.items;
  const open = await api('GET', `/history/checkouts/${cart.id}`, { as: people.ravi });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const { item } = open.body.data;
  assert.equal(item.id, cart.id);
  assert.equal(item.invoiceNumber, cart.invoiceNumber);
  assert.equal(item.customerName, 'Meera Shah');
  assert.equal(item.pieceCount, 2);
  assert.equal(item.grandTotal, cart.grandTotal);
  assert.deepEqual(item.pieces, [
    { itemName: '22K Gold Necklace', tagCode: 'TAG-10432', mrp: 82694, wishlistItemId: 'wl-1', scanId: 'scan-ravi-1' },
    { itemName: '18K Diamond Ring', tagCode: 'TAG-20117', mrp: 31437, wishlistItemId: null, scanId: null },
  ]);
  assert.match(item.invoiceUrl, /^https:\/\/api\.example\.test\/api\/v1\/invoices\/p\/[a-f0-9]{32}$/);

  assert.equal((await api('GET', `/history/checkouts/${cart.id}`, { as: people.owner })).status, 200);
  assert.equal((await api('GET', `/history/checkouts/${cart.id}`, { as: people.sita })).status, 404);
  assert.equal((await api('GET', `/history/checkouts/${cart.id}`, { as: people.otherOwner })).status, 404);
  assert.equal((await api('GET', '/history/checkouts/nope', { as: people.owner })).status, 404);
});

// ── Indexes and lifetime ──────────────────────────────────────────────

test("every history list reads the lines it shows, not the whole shop's, page after page", async () => {
  const busyShop = new mongoose.Types.ObjectId();
  const ownerId = String(new mongoose.Types.ObjectId());
  const clerkId = String(new mongoose.Types.ObjectId());
  const start = Date.now() - 60 * 60 * 1000;
  // Pairs in the same millisecond, so the tie-break is in play.
  const at = (i) => new Date(start + Math.floor(i / 2) * 1000);
  const userOf = (i) => (i % 2 ? clerkId : ownerId);
  await WishlistHistory.insertMany(Array.from({ length: 300 }, (_, i) => ({
    businessId: busyShop, userId: userOf(i), wishlistItemId: `wl-${i}`, itemName: '22K Gold', mrp: i, createdAt: at(i),
  })));
  await Invoice.insertMany(Array.from({ length: 300 }, (_, i) => ({
    businessId: busyShop,
    userId: userOf(i),
    invoiceNumber: `26-27/1017/${String(i).padStart(5, '0')}`,
    invoiceDate: '17-10-2026',
    subtotal: 100,
    gstRate: 3,
    gstAmount: 3,
    grandTotal: 103,
    // Unique, as every invoice's is (a sparse unique index; null counts).
    publicToken: `busy${String(i).padStart(28, '0')}`,
    fromCart: true,
    createdAt: at(i),
  })));

  const lists = [
    ['wishlist', wishlistHistory.wishlistQuery, wishlistHistory.listWishlist],
    ['checkouts', checkoutHistory.checkoutsQuery, checkoutHistory.listCheckouts],
  ];
  for (const [name, query, list] of lists) {
    for (const [label, user] of [
      ['owner', { businessId: busyShop, userId: ownerId, role: 'OWNER' }],
      ['employee', { businessId: busyShop, userId: clerkId, role: 'EMP' }],
    ]) {
      const { nextCursor } = await list(user, { limit: 30 });
      for (const [page, before] of [['first page', undefined], ['next page', nextCursor]]) {
        const explained = await query(user, { limit: 30, before }).explain('executionStats');
        const { queryPlanner, executionStats } = Array.isArray(explained) ? explained[0] : explained;
        const where = `${name}, ${label}, ${page}`;
        assert.doesNotMatch(JSON.stringify(queryPlanner.winningPlan), /"stage":"SORT"/, `${where}: sorted by an index`);
        assert.equal(executionStats.nReturned, 31, where);
        assert.ok(executionStats.totalDocsExamined <= 31, `${where}: read ${executionStats.totalDocsExamined} for 30`);
      }
    }
  }

  // The checkouts index replaced the old { businessId, userId, createdAt } one.
  const keys = (await Invoice.collection.indexes()).map((index) => JSON.stringify(index.key));
  assert.ok(keys.includes(JSON.stringify({ businessId: 1, userId: 1, createdAt: -1, _id: -1 })));
  assert.ok(keys.includes(JSON.stringify({ businessId: 1, createdAt: -1, _id: -1 })));
  assert.ok(keys.includes(JSON.stringify({ businessId: 1, userId: 1, fromCart: 1, createdAt: -1, _id: -1 })));
  assert.ok(keys.includes(JSON.stringify({ businessId: 1, fromCart: 1, createdAt: -1, _id: -1 })));
});

test('wishlist history lasts 180 days, and leaves with the account that made it', async () => {
  const ttl = (await WishlistHistory.collection.indexes()).find((index) => index.expireAfterSeconds !== undefined);
  assert.deepEqual(ttl?.key, { createdAt: 1 });
  assert.equal(ttl.expireAfterSeconds, 180 * 24 * 60 * 60);

  const gone = new mongoose.Types.ObjectId();
  const clerk = String(new mongoose.Types.ObjectId());
  const boss = String(new mongoose.Types.ObjectId());
  await WishlistHistory.insertMany([
    { businessId: gone, userId: clerk, wishlistItemId: 'g-1' },
    { businessId: gone, userId: boss, wishlistItemId: 'g-2' },
  ]);
  await accountDeletionService.deleteAccount({ businessId: gone, userId: clerk, role: 'EMP' });
  assert.equal(await WishlistHistory.countDocuments({ userId: clerk }), 0, "the employee's own lines go");
  assert.equal(await WishlistHistory.countDocuments({ businessId: gone }), 1);
  await accountDeletionService.deleteAccount({ businessId: gone, userId: boss, role: 'OWNER' });
  assert.equal(await WishlistHistory.countDocuments({ businessId: gone }), 0, "the shop's go with the shop");
  assert.ok(await WishlistHistory.countDocuments({ businessId: shop.id }) > 0, "another shop's are untouched");
});

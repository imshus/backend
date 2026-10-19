/**
 * Masters -> Labour Code: the shop's labour codes (LB-01 at Rs 415 a gram,
 * LB-02 at Rs 380 …), kept like the wastage codes, and the labour a scan is
 * priced with once a code is picked on the card or printed on the tag.
 *
 *   - GET / POST / DELETE /api/v1/labour-codes: each user reads their own
 *     list, else the shop's; an employee's first change gives them a private
 *     copy of the whole list; a code is unique per list by its letters and
 *     digits (LB-01 and "lb 01" are one code).
 *   - /calculate: the code picked on the card (labourCode) is found first,
 *     then the tag's identifiers; a labour figure the card sends beats the
 *     code's rate; with no code the labour is exactly what it was before.
 *     breakdown.labourCode records the code; the scan's history line keeps it.
 *   - /analyze: names the code the tag carries (labourCode), priced or not.
 *
 * Runs against a real (in-memory) MongoDB with the real routes and
 * controllers. The model's reading, the live gold rate and the scan session
 * are stood in for; no paid API is reached.
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
process.env.SCAN_STORE = 'memory';

const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Business = require('../src/models/business.model');
const BusinessUser = require('../src/models/businessUser.model');
const Employee = require('../src/models/employee.model');
const ItemCode = require('../src/models/itemCode.model');
const LabourCode = require('../src/models/labourCode.model');
const LabourRate = require('../src/models/labourRate.model');
const ScanHistory = require('../src/models/scanHistory.model');
const authService = require('../src/services/auth.service');
const rateCalculationService = require('../src/services/rateCalculation.service');
const redisService = require('../src/services/redis.service');
const scanService = require('../src/services/scan.service');
const scanController = require('../src/controllers/scan.controller');
const calculationController = require('../src/controllers/calculation.controller');
const { authenticateJWT } = require('../src/middleware/auth.middleware');
const errorHandler = require('../src/middleware/errorHandler');
const { findLabourRow, codeLabourOf } = require('../src/services/labourResolution.service');
const { validateCalculationInput } = require('../src/services/pricingInputs');

// The board: 24K at Rs 1,50,000 per 10 g (22K at 91.6% is Rs 13,740 a
// gram), unless a test takes the live rate away.
const board = { live: true };
rateCalculationService.getLiveGoldRates = async () => (board.live
  ? {
    karatRates: [{ carat: '22K', purity: 91.6 }, { carat: '18K', purity: 75 }],
    taxSettings: { rtgsFinalRate: 150000, cashFinalRate: 150000 },
    supremeChanges: { rtgsChange: 0, cashChange: 0 },
  }
  : { karatRates: [], taxSettings: {} });

// The scan sessions, as Redis (or the in-memory store) would hold them.
const scans = new Map();
const originalAnalyzeScan = scanService.analyzeScan;
redisService.getScan = async (scanId) => scans.get(scanId) || null;
redisService.updateScanStatus = async (scanId, status, extra) => ({ scanId, status, ...extra });

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

const list = (who) => api('GET', '/labour-codes', { as: who });
const save = (who, body) => api('POST', '/labour-codes', { as: who, body });
const remove = (who, id) => api('DELETE', `/labour-codes/${id}`, { as: who });
const codesOf = (response) => response.body.data.map((row) => `${row.code}=${row.rate}/${row.unit}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message || 'value'}: ${actual} is not ${expected}`);

/** The scan's history line once it says `until` (lines are written just after the answer). */
async function lineOf(scanId, until = () => true) {
  for (let tries = 0; tries < 150; tries += 1) {
    const line = await ScanHistory.findOne({ scanId }).lean();
    if (line && until(line)) return line;
    await sleep(20);
  }
  return ScanHistory.findOne({ scanId }).lean();
}

// A plain 22K piece: 10 g net, 10.5 g gross; gold 10 x 91.6% x 15,000 = 1,37,400.
const PIECE = { jewelleryType: 'GOLD', netWt: 10, grossWt: 10.5, purityKarat: '22K', calculationMode: 'rtgs' };
const GOLD = 137400;

let scanCount = 0;
/** The card's price for a scan `who` owns, by the current app's rules unless `rules` says otherwise. */
async function priced(who, body, { rules = 3, scanId = `scan-${(scanCount += 1)}` } = {}) {
  scans.set(scanId, {
    scanId,
    ownerUserId: String(who.userId),
    businessId: String(who.businessId),
    status: 'READY_FOR_REVIEW',
    calculationMode: 'rtgs',
    jewelleryType: 'GOLD',
  });
  const response = await api('POST', `/scans/${scanId}/calculate`, {
    as: who,
    body: { ...PIECE, ...body },
    headers: rules >= 2 ? { 'x-pricing-rules': String(rules) } : {},
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { ...response.body.data, scanId };
}

const field = (value, confidence = 95) => ({ value, confidence });

/** A gold tag's reading: item number GR10286, and TAG NO LB-02 printed beside it. */
const readingOf = ({ serial = 'GR10286', extraLine = 'TAG NO LB-02', labour = '' } = {}) => ({
  provider: 'openai-test',
  rawText: { merged: `${serial}\nGR WT 10.500 NT WT 10.000\n22K 916\n${extraLine}` },
  structuredData: {
    serialNumber: field(serial),
    grossWeight: field('10.500'),
    netWeight: field('10.000'),
    karat: field('22K'),
    purity: field('916'),
    labour: field(labour),
    diamonds: [],
    colorstones: [],
  },
  unknownFields: [],
  overallConfidence: 92,
});

/** The analyze endpoint for a scan `who` owns, the model's reading stood in for. */
async function analyze(who, scanId, reading, { rules = 3 } = {}) {
  const record = {
    scanId,
    ownerUserId: String(who.userId),
    businessId: String(who.businessId),
    status: 'ANALYSIS_COMPLETED',
    jewelleryType: 'GOLD',
    calculationMode: 'rtgs',
    analysisResult: reading,
    billing: { billed: false },
  };
  scans.set(scanId, record);
  scanService.analyzeScan = async () => record;
  const response = await api('POST', `/scans/${scanId}/analyze`, {
    as: who,
    body: {},
    headers: rules >= 2 ? { 'x-pricing-rules': String(rules) } : {},
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

/** The shop's own list, as the owner saves it (rates in rupees unless the unit says otherwise). */
async function shopCodes(rows) {
  await LabourCode.deleteMany({ businessId: shop.id });
  for (const row of rows) {
    const saved = await save(people.owner, row);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
}

const quiet = async (fn) => {
  const { log, info, warn } = console;
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.info = info;
    console.warn = warn;
  }
};

test.before(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongoServer.getUri());
  // The unique (shop, user, code) index is what one code per list rests on.
  await LabourCode.init();
  await ScanHistory.init();

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
    businessId: shop.id, phone: '9000000001', passwordHash: 'x', mpinHash: 'x', role: 'OWNER',
  });
  const ravi = await Employee.create({ businessId: shop.id, name: 'Ravi', phone: '9811100001' });
  const sita = await Employee.create({ businessId: shop.id, name: 'Sita', phone: '9811100002' });
  const otherOwner = await BusinessUser.create({
    businessId: otherShop.id, phone: '9000000002', passwordHash: 'x', role: 'OWNER',
  });
  people.owner = { businessId: shop.id, userId: owner._id, role: 'OWNER' };
  people.ravi = { businessId: shop.id, userId: ravi._id, role: 'EMP' };
  people.sita = { businessId: shop.id, userId: sita._id, role: 'EMP' };
  people.otherOwner = { businessId: otherShop.id, userId: otherOwner._id, role: 'OWNER' };

  // The shop's labour charge, Rs 650 a gram on the net weight, and Masters
  // item GR at Rs 700 a gram.
  await LabourRate.create({
    businessId: shop.id, userId: null, chargeType: 'AMOUNT', value: 650, rupeesUnit: 'Per Gram', weightBasis: 'net',
  });
  await ItemCode.create({ businessId: shop.id, code: 'GR', description: 'Gold Ring', labour: 700 });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/labour-codes', require('../src/routes/labourCode.routes'));
  // The scan routes as scan.routes mounts them, without the licence gates
  // in front of every scan route (scanAccess.test.js covers those).
  app.post('/api/v1/scans/:scanId/calculate', authenticateJWT, calculationController.calculateMRP);
  app.post('/api/v1/scans/:scanId/analyze', authenticateJWT, scanController.analyzeScan);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(async () => {
  scanService.analyzeScan = originalAnalyzeScan;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

// ── The rules on their own ───────────────────────────────────────────────

test('a code is found by its letters and digits, the identifiers tried in order', () => {
  const rows = [{ code: 'LB-01', rate: 415 }, { code: 'LB-02', rate: 380 }];
  assert.equal(findLabourRow(rows, ['lb 02'])?.code, 'LB-02');
  assert.equal(findLabourRow(rows, ['LB01'])?.code, 'LB-01');
  // The first identifier that names a code wins: the picked one is sent first.
  assert.equal(findLabourRow(rows, ['LB-02', 'LB-01'])?.code, 'LB-02');
  assert.equal(findLabourRow(rows, ['261440', 'LB-01'])?.code, 'LB-01');
  assert.equal(findLabourRow(rows, ['261440']), null);
  assert.equal(findLabourRow(rows, ['', '--']), null);
  assert.equal(findLabourRow([], ['LB-01']), null);
  assert.equal(findLabourRow(rows, []), null);
});

test("a code's labour is its rate in its unit; no rate, or a percent past 100, is none", () => {
  assert.deepEqual(codeLabourOf({ code: 'LB-01', rate: 415, unit: 'Per Gram' }), { amount: 415, unit: 'Per Gram' });
  assert.deepEqual(codeLabourOf({ code: 'LB-10', rate: 4200, unit: 'Per 10 Gram' }), { amount: 4200, unit: 'Per 10 Gram' });
  assert.deepEqual(codeLabourOf({ code: 'LBP', rate: 12, unit: 'Percent' }), { amount: 12, unit: 'Percent' });
  assert.deepEqual(codeLabourOf({ code: 'LB-0', rate: 0 }), { amount: 0, unit: 'Per Gram' });
  assert.equal(codeLabourOf({ code: 'LB-X', rate: null }), null);
  assert.equal(codeLabourOf({ code: 'LBP', rate: 120, unit: 'Percent' }), null);
  assert.equal(codeLabourOf(null), null);
});

test('labourCode in a /calculate body is text, trimmed, and nothing when blank', () => {
  assert.equal(validateCalculationInput({ labourCode: '  LB-01 ' }).labourCode, 'LB-01');
  assert.equal(validateCalculationInput({ labourCode: 7 }).labourCode, '7');
  for (const blank of [undefined, null, '', '   ']) {
    assert.equal(validateCalculationInput({ labourCode: blank }).labourCode, '');
  }
  assert.equal(validateCalculationInput({ labourCode: 'X'.repeat(30) }).labourCode, 'X'.repeat(20));
  for (const bad of [{ code: 'LB-01' }, ['LB-01'], true]) {
    assert.throws(() => validateCalculationInput({ labourCode: bad }), /labourCode must be text/);
  }
});

// ── GET / POST / DELETE /labour-codes ────────────────────────────────────

test('the owner adds, lists A to Z, edits and deletes the shop\'s codes', async () => {
  const added = await save(people.owner, { code: ' lb-02 ', rate: 380 });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.success, true);
  const row = added.body.data;
  assert.equal(row.code, 'LB-02', 'uppercase, trimmed');
  assert.equal(row.rate, 380);
  assert.equal(row.unit, 'Per Gram', 'per gram when no unit is sent');
  assert.equal(row.userId, null, "the owner's codes are the shop's");
  assert.equal(String(row.businessId), String(shop.id));
  assert.ok(row._id && row.createdAt && row.updatedAt);

  await save(people.owner, { code: 'LB-01', rate: '415' });
  await save(people.owner, { code: 'LBP', rate: 12, unit: 'percent' });
  const listed = await list(people.owner);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.success, true);
  assert.deepEqual(codesOf(listed), ['LB-01=415/Per Gram', 'LB-02=380/Per Gram', 'LBP=12/Percent']);

  // Edited by its id: the rate, the unit and the code itself.
  const edited = await save(people.owner, { id: row._id, code: 'LB-02', rate: 3900, unit: 'Per 10 Gram' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(String(edited.body.data._id), String(row._id));
  assert.deepEqual(codesOf(await list(people.owner)), ['LB-01=415/Per Gram', 'LB-02=3900/Per 10 Gram', 'LBP=12/Percent']);
  const renamed = await save(people.owner, { id: row._id, code: 'LB-03', rate: 3900, unit: 'Per 10 Gram' });
  assert.equal(renamed.body.data.code, 'LB-03');

  // A blank rate stays blank: the shop has not given one.
  const blank = await save(people.owner, { code: 'LB-09', rate: '' });
  assert.equal(blank.status, 200);
  assert.equal(blank.body.data.rate, null);

  const gone = await remove(people.owner, blank.body.data._id);
  assert.deepEqual(gone.body, { success: true, message: 'Deleted successfully' });
  assert.deepEqual(codesOf(await list(people.owner)), ['LB-01=415/Per Gram', 'LB-03=3900/Per 10 Gram', 'LBP=12/Percent']);
  // Deleting what is not there is not an error.
  assert.equal((await remove(people.owner, new mongoose.Types.ObjectId())).status, 200);
  assert.equal((await remove(people.owner, 'not-an-id')).status, 200);
});

test('a code already in the list, however it is spaced or punctuated, is a 409', async () => {
  await shopCodes([{ code: 'LB-01', rate: 415 }, { code: 'LB-02', rate: 380 }]);
  for (const code of ['LB-01', 'lb 01', 'LB01', 'L.B-0 1']) {
    const dup = await save(people.owner, { code, rate: 500 });
    assert.equal(dup.status, 409, code);
    assert.deepEqual(dup.body, { success: false, message: 'This labour code already exists' });
  }
  // Renaming one code onto another is the same clash; keeping its own is not.
  const [one] = (await list(people.owner)).body.data;
  assert.equal((await save(people.owner, { id: one._id, code: 'LB 02', rate: 415 })).status, 409);
  assert.equal((await save(people.owner, { id: one._id, code: 'lb-01', rate: 420 })).status, 200);
  assert.deepEqual(codesOf(await list(people.owner)), ['LB-01=420/Per Gram', 'LB-02=380/Per Gram']);
});

test('a save that cannot be kept is a 400 saying why, and nothing is written', async () => {
  await shopCodes([{ code: 'LB-01', rate: 415 }]);
  const cases = [
    [{ rate: 415 }, 'Labour code is required'],
    [{ code: '   ', rate: 415 }, 'Labour code is required'],
    [{ code: '--', rate: 415 }, 'Labour code is required'],
    [{ code: 'L'.repeat(21), rate: 415 }, 'Labour code must stay within 20 characters'],
    [{ code: 'LB-05', rate: -1 }, 'Labour rate must be a number of rupees, 0 or more'],
    [{ code: 'LB-05', rate: 'abc' }, 'Labour rate must be a number of rupees, 0 or more'],
    [{ code: 'LB-05', rate: 120, unit: 'Percent' }, 'Labour must be a percentage between 0 and 100'],
    [{ code: 'LB-05', rate: 415, unit: 'Per Kilo' }, 'Unit must be "Per Gram", "Per 10 Gram" or "Percent"'],
    [{ code: 'LB-05', rate: 415, unit: 5 }, 'Unit must be "Per Gram", "Per 10 Gram" or "Percent"'],
  ];
  for (const [body, message] of cases) {
    const refused = await save(people.owner, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.deepEqual(refused.body, { success: false, message }, JSON.stringify(body));
  }
  // 0-100 holds for a percent; 0 and 100 themselves are fine, as is "₹ 1,250".
  assert.equal((await save(people.owner, { code: 'LBP0', rate: 0, unit: 'Percent' })).status, 200);
  assert.equal((await save(people.owner, { code: 'LBP100', rate: 100, unit: '%' })).status, 200);
  const rupees = await save(people.owner, { code: 'LB-12', rate: '₹ 1,250' });
  assert.equal(rupees.body.data.rate, 1250);
  assert.deepEqual(codesOf(await list(people.owner)), [
    'LB-01=415/Per Gram', 'LB-12=1250/Per Gram', 'LBP0=0/Percent', 'LBP100=100/Percent',
  ]);
  // An id that is no code of this shop's.
  const missing = await save(people.owner, { id: new mongoose.Types.ObjectId(), code: 'LB-07', rate: 1 });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { success: false, message: 'Labour code not found' });
});

test("an employee reads the shop's codes; their first change gives them their own copy", async () => {
  await shopCodes([{ code: 'LB-01', rate: 415 }, { code: 'LB-02', rate: 380 }]);
  const shopList = await list(people.ravi);
  assert.deepEqual(codesOf(shopList), ['LB-01=415/Per Gram', 'LB-02=380/Per Gram']);
  assert.ok(shopList.body.data.every((row) => row.userId === null), "the shop's rows");

  // Ravi edits LB-01 by the shop row's id: his whole list is copied first.
  const shopLb01 = shopList.body.data.find((row) => row.code === 'LB-01');
  const edited = await save(people.ravi, { id: shopLb01._id, code: 'LB-01', rate: 500 });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(String(edited.body.data.userId), String(people.ravi.userId));
  assert.notEqual(String(edited.body.data._id), String(shopLb01._id), 'his copy, not the shop row');
  const ravis = await list(people.ravi);
  assert.deepEqual(codesOf(ravis), ['LB-01=500/Per Gram', 'LB-02=380/Per Gram']);
  assert.ok(ravis.body.data.every((row) => String(row.userId) === String(people.ravi.userId)));

  // The shop's list, the owner's and Sita's, is untouched.
  assert.deepEqual(codesOf(await list(people.owner)), ['LB-01=415/Per Gram', 'LB-02=380/Per Gram']);
  assert.deepEqual(codesOf(await list(people.sita)), ['LB-01=415/Per Gram', 'LB-02=380/Per Gram']);

  // Deleting by the shop row's id deletes his copy only.
  const shopLb02 = shopList.body.data.find((row) => row.code === 'LB-02');
  assert.equal((await remove(people.ravi, shopLb02._id)).status, 200);
  assert.deepEqual(codesOf(await list(people.ravi)), ['LB-01=500/Per Gram']);
  assert.deepEqual(codesOf(await list(people.owner)), ['LB-01=415/Per Gram', 'LB-02=380/Per Gram']);

  // Sita's first change is a new code: she too starts from the shop's list.
  assert.equal((await save(people.sita, { code: 'LB-07', rate: 450 })).status, 200);
  assert.deepEqual(codesOf(await list(people.sita)), ['LB-01=415/Per Gram', 'LB-02=380/Per Gram', 'LB-07=450/Per Gram']);
  // A clash is judged in her own list.
  assert.equal((await save(people.sita, { code: 'lb 07', rate: 1 })).status, 409);

  // Another shop sees none of it, and cannot touch it by id.
  assert.deepEqual((await list(people.otherOwner)).body.data, []);
  assert.equal((await save(people.otherOwner, { id: shopLb01._id, code: 'LB-01', rate: 1 })).status, 404);
  await remove(people.otherOwner, shopLb01._id);
  assert.deepEqual(codesOf(await list(people.owner)), ['LB-01=415/Per Gram', 'LB-02=380/Per Gram']);

  // Without a sign-in, nothing.
  assert.equal((await api('GET', '/labour-codes')).status, 401);
  assert.equal((await api('POST', '/labour-codes', { body: { code: 'LB-01', rate: 1 } })).status, 401);

  await LabourCode.deleteMany({ businessId: shop.id, userId: { $ne: null } });
});

// ── The price ────────────────────────────────────────────────────────────

const labourOf = (data) => ({
  type: data.breakdown.labourChargeType,
  amount: data.breakdown.labourAmount,
  code: data.breakdown.labourCode,
});

test('no labour code: the labour is exactly what it was before labour codes', async () => {
  const bodies = [
    // The shop's Rs 650 a gram.
    {},
    // Item GR's Rs 700 a gram, from the tag number.
    { itemCode: 'GR10286', tagIdentifiers: ['GR10286'] },
    // The card's own figure.
    { labourChargeAmount: '850', labourChargeUnit: 'Per Gram', tagIdentifiers: ['261440'] },
    { labourChargeAmount: '12%', labourWeightBasis: 'gross' },
  ];
  await LabourCode.deleteMany({});
  const before = [];
  for (const body of bodies) before.push(await quiet(() => priced(people.owner, body, { scanId: 'scan-before' })));
  assert.deepEqual(labourOf(before[0]), { type: 'AMOUNT_GLOBAL', amount: 6500, code: '' });
  assert.deepEqual(labourOf(before[1]), { type: 'AMOUNT_ITEM', amount: 7000, code: '' });
  assert.deepEqual(labourOf(before[2]), { type: 'AMOUNT_MANUAL', amount: 8500, code: '' });

  // Codes saved, none of them on the tag or picked: not a rupee moves.
  await shopCodes([{ code: 'LB-01', rate: 415 }, { code: 'LB-02', rate: 380 }]);
  for (const [i, body] of bodies.entries()) {
    const after = await quiet(() => priced(people.owner, body, { scanId: 'scan-before' }));
    assert.deepEqual(after, before[i], JSON.stringify(body));
  }
});

test('a code the tag prints prices the labour at its rate, ahead of the item\'s and the shop\'s', async () => {
  await shopCodes([
    { code: 'LB-01', rate: 415 },
    { code: 'LB-02', rate: 380 },
    { code: 'LB-10', rate: 4200, unit: 'Per 10 Gram' },
    { code: 'LBP', rate: 12, unit: 'Percent' },
  ]);
  // The tag's number is item GR (Rs 700), and LB-02 is printed beside it.
  const tagged = await quiet(() => priced(people.owner, { itemCode: 'GR10286', tagIdentifiers: ['GR10286', 'LB 02'] }));
  assert.deepEqual(labourOf(tagged), { type: 'AMOUNT_CODE', amount: 3800, code: 'LB-02' });
  near(tagged.finalMRP, GOLD + 3800, 'MRP');

  // Per 10 g, on the gross weight the card names.
  const per10 = await quiet(() => priced(people.owner, { tagIdentifiers: ['LB-10'], labourWeightBasis: 'gross' }));
  assert.equal(per10.breakdown.labourChargeType, 'AMOUNT_CODE');
  near(per10.breakdown.labourAmount, 10.5 * 420, 'per 10 g on gross');

  // A percent of the gold value.
  const percent = await quiet(() => priced(people.owner, { tagIdentifiers: ['lbp'] }));
  assert.equal(percent.breakdown.labourChargeType, 'PERCENTAGE_CODE');
  assert.equal(percent.breakdown.labourCode, 'LBP');
  near(percent.breakdown.labourAmount, GOLD * 0.12, '12% of the gold');

  // A code without a rate names the scan but prices nothing: the item's.
  await save(people.owner, { code: 'LB-00', rate: '' });
  const unrated = await quiet(() => priced(people.owner, { itemCode: 'GR10286', tagIdentifiers: ['GR10286', 'LB-00'] }));
  assert.deepEqual(labourOf(unrated), { type: 'AMOUNT_ITEM', amount: 7000, code: 'LB-00' });
});

test('the code picked on the card comes first; one no longer saved gives way to the tag\'s', async () => {
  await shopCodes([{ code: 'LB-01', rate: 415 }, { code: 'LB-02', rate: 380 }]);
  const picked = await quiet(() => priced(people.owner, { tagIdentifiers: ['LB-02'], labourCode: 'LB-01' }));
  assert.deepEqual(labourOf(picked), { type: 'AMOUNT_CODE', amount: 4150, code: 'LB-01' });

  // Picked on a tag that prints no identifier at all, spaced its own way.
  const alone = await quiet(() => priced(people.owner, { labourCode: 'lb 01' }));
  assert.deepEqual(labourOf(alone), { type: 'AMOUNT_CODE', amount: 4150, code: 'LB-01' });

  const gone = await quiet(() => priced(people.owner, { tagIdentifiers: ['LB-02'], labourCode: 'LB-99' }));
  assert.deepEqual(labourOf(gone), { type: 'AMOUNT_CODE', amount: 3800, code: 'LB-02' });

  // Neither picked nor printed any more: the shop's charge, as before.
  const none = await quiet(() => priced(people.owner, { labourCode: 'LB-99' }));
  assert.deepEqual(labourOf(none), { type: 'AMOUNT_GLOBAL', amount: 6500, code: '' });
});

test('a labour figure the card sends beats the code\'s rate; the code is still recorded', async () => {
  await shopCodes([{ code: 'LB-01', rate: 415 }, { code: 'LB-02', rate: 380 }]);
  // Typed over the picked code's rate.
  const typed = await quiet(() => priced(people.owner, {
    labourCode: 'LB-01', labourChargeAmount: '500', labourChargeUnit: 'Per Gram',
  }));
  assert.deepEqual(labourOf(typed), { type: 'AMOUNT_MANUAL', amount: 5000, code: 'LB-01' });
  // The card's box holding the tag's code's own rate: the same figure either way.
  const filled = await quiet(() => priced(people.owner, {
    tagIdentifiers: ['LB-02'], labourChargeAmount: 380, labourChargeUnit: 'Per Gram',
  }));
  assert.deepEqual(labourOf(filled), { type: 'AMOUNT_MANUAL', amount: 3800, code: 'LB-02' });
  // A percent typed beats a rupee code.
  const percent = await quiet(() => priced(people.owner, { labourCode: 'LB-02', labourChargeAmount: '10%' }));
  assert.equal(percent.breakdown.labourChargeType, 'PERCENTAGE_MANUAL');
  near(percent.breakdown.labourAmount, GOLD * 0.1, '10% typed');
  assert.equal(percent.breakdown.labourCode, 'LB-02');
});

test('a build on rules 1 matches no labour code and is priced as it always was', async () => {
  await shopCodes([{ code: 'LB-01', rate: 415 }]);
  const legacy = await quiet(() => priced(people.owner, { tagIdentifiers: ['LB-01'], labourCode: 'LB-01' }, { rules: 1 }));
  assert.deepEqual(labourOf(legacy), { type: 'AMOUNT_GLOBAL', amount: 6500, code: '' });
});

test("each account prices by its own list: an employee's copy, else the shop's", async () => {
  await shopCodes([{ code: 'LB-01', rate: 415 }, { code: 'LB-02', rate: 380 }]);
  const shopLb01 = (await list(people.ravi)).body.data.find((row) => row.code === 'LB-01');
  await save(people.ravi, { id: shopLb01._id, code: 'LB-01', rate: 500 });

  const ravi = await quiet(() => priced(people.ravi, { labourCode: 'LB-01' }));
  assert.deepEqual(labourOf(ravi), { type: 'AMOUNT_CODE', amount: 5000, code: 'LB-01' });
  const sita = await quiet(() => priced(people.sita, { labourCode: 'LB-01' }));
  assert.deepEqual(labourOf(sita), { type: 'AMOUNT_CODE', amount: 4150, code: 'LB-01' });
  const owner = await quiet(() => priced(people.owner, { labourCode: 'LB-01' }));
  assert.deepEqual(labourOf(owner), { type: 'AMOUNT_CODE', amount: 4150, code: 'LB-01' });
  // Another shop has no such code.
  const elsewhere = await quiet(() => priced(people.otherOwner, { labourCode: 'LB-01' }));
  assert.deepEqual(labourOf(elsewhere), { type: 'NONE', amount: 0, code: '' });

  await LabourCode.deleteMany({ businessId: shop.id, userId: { $ne: null } });
});

test("the scan's history line keeps the code picked and the code priced", async () => {
  await shopCodes([{ code: 'LB-01', rate: 415 }, { code: 'LB-02', rate: 380 }]);
  const answer = await quiet(() => priced(people.owner, { tagIdentifiers: ['LB-02'], labourCode: 'LB-01' }, { scanId: 'scan-history-1' }));
  const line = await lineOf('scan-history-1', (row) => row.status === 'priced');
  assert.equal(line.finalMRP, answer.finalMRPRounded);
  assert.equal(line.pricing.inputs.labourCode, 'LB-01');
  assert.equal(line.pricing.breakdown.labourCode, 'LB-01');
  assert.equal(line.pricing.breakdown.labourChargeType, 'AMOUNT_CODE');
  assert.equal(line.pricing.breakdown.labourRate, 415);
  assert.equal(line.pricing.breakdown.labourUnit, 'Per Gram');

  // Matched from the tag, none picked.
  await quiet(() => priced(people.owner, { tagIdentifiers: ['LB-02'] }, { scanId: 'scan-history-2' }));
  const matched = await lineOf('scan-history-2', (row) => row.status === 'priced');
  assert.equal(matched.pricing.inputs.labourCode, '');
  assert.equal(matched.pricing.breakdown.labourCode, 'LB-02');
});

// ── The analysis ─────────────────────────────────────────────────────────

test('the analysis names the code the tag prints, and prices the labour the card opens with', async () => {
  await shopCodes([{ code: 'LB-01', rate: 415 }, { code: 'LB-02', rate: 380 }]);

  // The card opens with item GR's Rs 700 in its labour box, which it sends:
  // that figure beats the code's rate, and the code is named.
  const withItem = await quiet(() => analyze(people.owner, 'scan-read-1', readingOf()));
  assert.equal(withItem.labourCode, 'LB-02');
  assert.equal(withItem.pricing.breakdown.labourCode, 'LB-02');
  assert.equal(withItem.pricingInput.labourChargeAmount, '700');
  assert.equal(withItem.pricingInput.labourCode, undefined, 'the card opens with no code picked');
  assert.equal(withItem.pricing.breakdown.labourChargeType, 'AMOUNT_MANUAL');
  near(withItem.pricing.breakdown.labourAmount, 7000, 'the card\'s opening labour');

  // A tag that prints its own labour opens with it, the code still named.
  const withTagLabour = await quiet(() => analyze(people.owner, 'scan-read-2', readingOf({ labour: '850|Per Gram' })));
  assert.equal(withTagLabour.labourCode, 'LB-02');
  near(withTagLabour.pricing.breakdown.labourAmount, 8500, 'the tag\'s labour');

  // No tag labour, no item and no shop charge: the box is empty, so the
  // code's rate prices the labour.
  await LabourRate.updateOne({ businessId: shop.id, userId: null }, { $set: { chargeType: 'NONE' } });
  try {
    const codeOnly = await quiet(() => analyze(people.owner, 'scan-read-3', readingOf({ serial: '261440' })));
    assert.equal(codeOnly.pricingInput.labourChargeAmount, undefined);
    assert.equal(codeOnly.labourCode, 'LB-02');
    assert.equal(codeOnly.pricing.breakdown.labourChargeType, 'AMOUNT_CODE');
    near(codeOnly.pricing.breakdown.labourAmount, 3800, "LB-02's rate");
  } finally {
    await LabourRate.updateOne({ businessId: shop.id, userId: null }, { $set: { chargeType: 'AMOUNT' } });
  }

  // No code on the tag: '' and the price as before.
  const plain = await quiet(() => analyze(people.owner, 'scan-read-4', readingOf({ extraLine: 'HM 916' })));
  assert.equal(plain.labourCode, '');
  assert.equal(plain.pricing.breakdown.labourCode, '');
  assert.equal(plain.pricing.breakdown.labourChargeType, 'AMOUNT_MANUAL');
  near(plain.pricing.breakdown.labourAmount, 7000, "item GR's labour");
});

test('without a live rate the analysis still names the code; rules 1 never does', async () => {
  await shopCodes([{ code: 'LB-01', rate: 415 }, { code: 'LB-02', rate: 380 }]);
  board.live = false;
  try {
    const unpriced = await quiet(() => analyze(people.owner, 'scan-read-5', readingOf()));
    assert.equal(unpriced.pricing, null);
    assert.equal(unpriced.pricingError.code, 'RATES_UNAVAILABLE');
    assert.equal(unpriced.labourCode, 'LB-02');
  } finally {
    board.live = true;
  }
  const legacy = await quiet(() => analyze(people.owner, 'scan-read-6', readingOf(), { rules: 1 }));
  assert.equal(legacy.labourCode, '');
  assert.equal(legacy.pricing.breakdown.labourCode, '');
});

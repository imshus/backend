/**
 * Settings -> History -> Tag scan history.
 *
 * Every price POST /scans/:scanId/calculate returns is the scan's line in
 * scan_history, one line per scan, the latest request's price winning; only
 * a scan on record starts a line. GET
 * /history/scans lists them newest first: the shop's for the owner, an
 * employee's own for an employee. A line names the Masters item the tag
 * matched, else the karat and type priced, and carries the tag's item number.
 * Writing it never fails or delays the price.
 *
 * Runs against a real (in-memory) MongoDB with the real calculate controller
 * and history route. The live gold rate and the scan session are stubbed; no
 * paid API is reached.
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
// Scan records in memory, where a scan id with no record is still priced.
process.env.SCAN_STORE = 'memory';

const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Business = require('../src/models/business.model');
const BusinessUser = require('../src/models/businessUser.model');
const Employee = require('../src/models/employee.model');
const ItemCode = require('../src/models/itemCode.model');
const ScanHistory = require('../src/models/scanHistory.model');
const authService = require('../src/services/auth.service');
const rateCalculationService = require('../src/services/rateCalculation.service');
const redisService = require('../src/services/redis.service');
const scanHistory = require('../src/services/scanHistory.service');
const accountDeletionService = require('../src/services/accountDeletion.service');
const calculationController = require('../src/controllers/calculation.controller');
const { authenticateJWT } = require('../src/middleware/auth.middleware');
const errorHandler = require('../src/middleware/errorHandler');

// The board the price is worked on: 24K at Rs 1,30,000 per 10 g.
rateCalculationService.getLiveGoldRates = async () => ({
  karatRates: [
    { carat: '22K', purity: 91.6 },
    { carat: '18K', purity: 75 },
  ],
  taxSettings: { rtgsFinalRate: 130000, cashFinalRate: 129000 },
  supremeChanges: { rtgsChange: 0, cashChange: 0 },
});

// The scan sessions, as Redis (or the in-memory store) would hold them.
const scans = new Map();
redisService.getScan = async (scanId) => scans.get(scanId) || null;
redisService.updateScanStatus = async (scanId, status, extra) => ({ scanId, status, ...extra });

let mongoServer;
let server;
let baseUrl;

const shop = { id: new mongoose.Types.ObjectId() };
const otherShop = { id: new mongoose.Types.ObjectId() };
const people = {};

const tokenOf = (who) => authService.generateTokens(String(who.businessId), String(who.userId), who.role).accessToken;

async function api(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json };
}

/**
 * The scan's history line once it says `until`. The line is written just
 * after the price has been answered, so a test that reads it straight after
 * the response waits for it here.
 */
async function lineOf(scanId, until = () => true) {
  for (let tries = 0; tries < 100; tries += 1) {
    const line = await ScanHistory.findOne({ scanId }).lean();
    if (line && until(line)) return line;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return ScanHistory.findOne({ scanId }).lean();
}

/** A scan session owned by `who`, as the scan store holds it. */
function openScan(who, scanId, jewelleryType = 'GOLD') {
  scans.set(scanId, {
    scanId,
    ownerUserId: String(who.userId),
    businessId: String(who.businessId),
    status: 'READY_FOR_REVIEW',
    calculationMode: 'rtgs',
    jewelleryType,
  });
}

/** The price of a scan id as the review card asks it, whether or not there is a record. */
const calculate = (who, scanId, body) => api('POST', `/scans/${scanId}/calculate`, {
  token: tokenOf(who),
  body: { jewelleryType: 'Gold', purityKarat: '22K', calculationMode: 'rtgs', ...body },
  // The current app's rules: the Masters item is found by its prefix.
  headers: { 'x-pricing-rules': '3' },
});

/**
 * A scan session owned by `who`, then its price, as the review card asks;
 * with `settle`, once the line carries that price.
 */
async function price(who, scanId, body, { jewelleryType = 'GOLD', settle = true } = {}) {
  openScan(who, scanId, jewelleryType);
  const answer = await calculate(who, scanId, body);
  if (settle && answer.status === 200) {
    await lineOf(scanId, (line) => line.finalMRP === answer.body.data.finalMRPRounded);
  }
  return answer;
}

/**
 * What the controller's next history write comes to: the entry it was asked
 * to write and whether a line was written. The write happens after the
 * price is answered, so a test that expects nothing written waits on this.
 */
function nextHistoryWrite() {
  const original = scanHistory.recordPricedScan;
  return new Promise((resolve, reject) => {
    scanHistory.recordPricedScan = async (entry) => {
      scanHistory.recordPricedScan = original;
      try {
        const written = await original(entry);
        resolve({ entry, written });
        return written;
      } catch (error) {
        reject(error);
        throw error;
      }
    };
  });
}

const history = (who, query = '') => api('GET', `/history/scans${query}`, { token: tokenOf(who) });

test.before(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongoServer.getUri());
  // The unique (shop, scan) index is what one line per scan rests on.
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
    businessId: shop.id,
    phone: '9000000001',
    passwordHash: 'x',
    mpinHash: 'x',
    role: 'OWNER',
  });
  const ravi = await Employee.create({ businessId: shop.id, name: 'Ravi', phone: '9811100001' });
  const sita = await Employee.create({ businessId: shop.id, name: 'Sita', phone: '9811100002' });
  const otherOwner = await BusinessUser.create({
    businessId: otherShop.id,
    phone: '9000000002',
    passwordHash: 'x',
    role: 'OWNER',
  });
  people.owner = { businessId: shop.id, userId: owner._id, role: 'OWNER' };
  people.ravi = { businessId: shop.id, userId: ravi._id, role: 'EMP' };
  people.sita = { businessId: shop.id, userId: sita._id, role: 'EMP' };
  people.otherOwner = { businessId: otherShop.id, userId: otherOwner._id, role: 'OWNER' };

  // Masters -> Item Code: NK is the shop's necklace; NK10432 is one of them.
  await ItemCode.create({ businessId: shop.id, code: 'NK', description: 'Gold Necklace' });

  const app = express();
  app.use(express.json());
  // The calculate route as scan.routes mounts it, without the licence gates
  // in front of every scan route (scanAccess.test.js covers those).
  app.post('/api/v1/scans/:scanId/calculate', authenticateJWT, calculationController.calculateMRP);
  app.use('/api/v1/history', require('../src/routes/history.routes'));
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('a priced scan is written with the Masters item name, the tag number and the price the card shows', async () => {
  const priced = await price(people.owner, 'scan-owner-1', { netWt: 10, grossWt: 10.5, itemCode: 'NK10432' });
  assert.equal(priced.status, 200, JSON.stringify(priced.body));
  const mrp = priced.body.data.finalMRPRounded;
  assert.ok(mrp > 0);

  const line = await ScanHistory.findOne({ scanId: 'scan-owner-1' }).lean();
  assert.ok(line, 'the calculate wrote a history line');
  assert.equal(String(line.businessId), String(shop.id));
  assert.equal(line.userId, String(people.owner.userId));
  assert.equal(line.itemName, 'Gold Necklace', "the Masters item's name");
  assert.equal(line.tagCode, 'NK10432', 'the item number the card shows');
  assert.equal(line.karat, '22K');
  assert.equal(line.finalMRP, mrp);

  const { status, body } = await history(people.owner);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.data.items[0]).sort(), ['createdAt', 'finalMRP', 'itemName', 'scanId', 'tagCode']);
  assert.deepEqual(
    { ...body.data.items[0], createdAt: undefined },
    { scanId: 'scan-owner-1', itemName: 'Gold Necklace', tagCode: 'NK10432', finalMRP: mrp, createdAt: undefined },
  );
});

test('pricing the same scan again replaces its line: one line, the latest price, the first time', async () => {
  const before = await ScanHistory.findOne({ scanId: 'scan-owner-1' }).lean();
  const repriced = await price(people.owner, 'scan-owner-1', { netWt: 12, grossWt: 12.5, itemCode: 'NK10432' });
  assert.equal(repriced.status, 200);

  const lines = await ScanHistory.find({ scanId: 'scan-owner-1' }).lean();
  assert.equal(lines.length, 1, 'still one line for the scan');
  assert.equal(lines[0].finalMRP, repriced.body.data.finalMRPRounded, 'the latest price wins');
  assert.notEqual(lines[0].finalMRP, before.finalMRP);
  assert.equal(lines[0].createdAt.getTime(), before.createdAt.getTime(), 'the scan keeps its time');
});

test('without a Masters item the line is named by the karat and type priced, and a tag without a number has none', async () => {
  assert.equal((await price(people.owner, 'scan-owner-2', { netWt: 5, grossWt: 5 })).status, 200);
  assert.equal(
    (await price(people.owner, 'scan-owner-3', {
      jewelleryType: 'Diamond',
      purityKarat: '18K',
      netWt: 4,
      grossWt: 4.2,
      itemCode: 'DR-77',
      diamonds: [{ weight: 0.5, rate: 50000 }],
    }, { jewelleryType: 'DIAMOND' })).status,
    200,
  );

  const gold = await ScanHistory.findOne({ scanId: 'scan-owner-2' }).lean();
  assert.equal(gold.itemName, '22K Gold');
  assert.equal(gold.tagCode, '');
  const diamond = await ScanHistory.findOne({ scanId: 'scan-owner-3' }).lean();
  assert.equal(diamond.itemName, '18K Diamond Jewellery');
  assert.equal(diamond.tagCode, 'DR-77');

  // The naming rule on its own, every type the scanner prices.
  const nameOf = (request, itemRow = null) => scanHistory.historyEntryOf({ request, itemRow }).itemName;
  assert.equal(nameOf({ purityKarat: '22K', jewelleryType: 'Gold' }), '22K Gold');
  assert.equal(nameOf({ purityKarat: '18K', jewelleryType: 'DIAMOND' }), '18K Diamond Jewellery');
  assert.equal(nameOf({ purityKarat: '', jewelleryType: 'Gold' }), 'Gold', 'no karat, just the type');
  assert.equal(nameOf({ purityKarat: '14K' }), '14K Jewellery');
  assert.equal(nameOf({ purityKarat: '22K', jewelleryType: 'Gold' }, { code: 'NK', description: ' ' }), '22K Gold',
    'an item with no name falls back too');
});

test('the owner sees the whole shop, newest first; an employee sees only their own', async () => {
  assert.equal((await price(people.ravi, 'scan-ravi-1', { netWt: 3, grossWt: 3 })).status, 200);
  assert.equal((await price(people.sita, 'scan-sita-1', { netWt: 2, grossWt: 2 })).status, 200);
  assert.equal((await price(people.ravi, 'scan-ravi-2', { netWt: 6, grossWt: 6, itemCode: 'NK20001' })).status, 200);
  assert.equal((await price(people.otherOwner, 'scan-other-1', { netWt: 1, grossWt: 1 })).status, 200);

  const ids = async (who, query) => (await history(who, query)).body.data.items.map((item) => item.scanId);
  assert.deepEqual(
    await ids(people.owner),
    ['scan-ravi-2', 'scan-sita-1', 'scan-ravi-1', 'scan-owner-3', 'scan-owner-2', 'scan-owner-1'],
    "the shop's scans, newest first, never another shop's",
  );
  assert.deepEqual(await ids(people.ravi), ['scan-ravi-2', 'scan-ravi-1']);
  assert.deepEqual(await ids(people.sita), ['scan-sita-1']);
  assert.deepEqual(await ids(people.otherOwner), ['scan-other-1']);

  assert.deepEqual(await ids(people.owner, '?limit=2'), ['scan-ravi-2', 'scan-sita-1']);
  assert.equal(scanHistory.listLimitOf(undefined), 30);
  assert.equal(scanHistory.listLimitOf('0'), 30);
  assert.equal(scanHistory.listLimitOf('500'), 100);

  assert.equal((await api('GET', '/history/scans')).status, 401, 'signed out');
});

test("a scan id can only ever update its own scanner's line", async () => {
  const before = await ScanHistory.findOne({ scanId: 'scan-ravi-1' }).lean();
  for (const mayCreate of [true, false]) {
    const written = await scanHistory.recordPricedScan({
      user: people.sita,
      scanId: 'scan-ravi-1',
      itemName: 'Not Ravi',
      karat: '22K',
      tagCode: 'X',
      finalMRP: 1,
      mayCreate,
    });
    assert.equal(written, false);
  }
  const after = await ScanHistory.findOne({ scanId: 'scan-ravi-1' }).lean();
  assert.equal(after.userId, before.userId);
  assert.equal(after.finalMRP, before.finalMRP);

  // Two prices for one new scan at once (the prefetch and the card): one line.
  const entry = { user: people.sita, scanId: 'scan-sita-2', itemName: '22K Gold', karat: '22K', tagCode: '', mayCreate: true };
  const pricedAt = new Date();
  const results = await Promise.all([
    scanHistory.recordPricedScan({ ...entry, finalMRP: 100, pricedAt }),
    scanHistory.recordPricedScan({ ...entry, finalMRP: 100, pricedAt }),
  ]);
  assert.deepEqual(results, [true, true]);
  assert.equal(await ScanHistory.countDocuments({ scanId: 'scan-sita-2' }), 1);
});

test('a price asked for earlier never replaces a later one, whichever lands last', async () => {
  const entry = { user: people.sita, scanId: 'scan-sita-order', itemName: '22K Gold', karat: '22K', tagCode: '', mayCreate: true };
  const asked = new Date(Date.now() - 60 * 1000);
  const later = (seconds) => new Date(asked.getTime() + seconds * 1000);
  assert.equal(await scanHistory.recordPricedScan({ ...entry, finalMRP: 200, pricedAt: later(1) }), true);
  assert.equal(await scanHistory.recordPricedScan({ ...entry, finalMRP: 100, pricedAt: asked }), false,
    'the earlier request, landing last, writes nothing');
  assert.equal((await ScanHistory.findOne({ scanId: 'scan-sita-order' }).lean()).finalMRP, 200);
  assert.equal(await scanHistory.recordPricedScan({ ...entry, finalMRP: 300, pricedAt: later(2) }), true);
  assert.equal((await ScanHistory.findOne({ scanId: 'scan-sita-order' }).lean()).finalMRP, 300);

  // End to end: the earlier request is held at its rate read until the
  // later one has answered and written its line, then let go.
  openScan(people.owner, 'scan-owner-race');
  const originalRates = rateCalculationService.getLiveGoldRates;
  let reached;
  const atRateRead = new Promise((resolve) => { reached = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  rateCalculationService.getLiveGoldRates = async (...args) => {
    rateCalculationService.getLiveGoldRates = originalRates;
    reached();
    await released;
    return originalRates(...args);
  };
  try {
    const first = calculate(people.owner, 'scan-owner-race', { netWt: 5, grossWt: 5 });
    await atRateRead;
    // So the two arrive in different milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await calculate(people.owner, 'scan-owner-race', { netWt: 7, grossWt: 7 });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const latest = second.body.data.finalMRPRounded;
    assert.equal((await lineOf('scan-owner-race', (line) => line.finalMRP === latest)).finalMRP, latest);

    const lateWrite = nextHistoryWrite();
    release();
    const earlier = await first;
    assert.equal(earlier.status, 200, JSON.stringify(earlier.body));
    assert.notEqual(earlier.body.data.finalMRPRounded, latest);
    assert.equal((await lateWrite).written, false, 'the earlier price, finishing last, changes nothing');
    assert.equal((await ScanHistory.findOne({ scanId: 'scan-owner-race' }).lean()).finalMRP, latest,
      'the line keeps the price the card shows');
  } finally {
    rateCalculationService.getLiveGoldRates = originalRates;
    release();
  }
});

test('a scan id with no record starts no line; a card whose record was dropped still updates its own', async () => {
  // Made up, or never scanned: priced from the request, as ever, but no line.
  const write = nextHistoryWrite();
  const madeUp = await calculate(people.sita, 'made-up-1', { netWt: 5, grossWt: 5 });
  assert.equal(madeUp.status, 200, JSON.stringify(madeUp.body));
  assert.ok(madeUp.body.data.finalMRPRounded > 0);
  const attempt = await write;
  assert.equal(attempt.entry.mayCreate, false);
  assert.equal(attempt.written, false);
  assert.equal(await ScanHistory.countDocuments({ scanId: 'made-up-1' }), 0);

  // A card still open after the store dropped its record: its line follows.
  assert.equal((await price(people.sita, 'scan-sita-dropped', { netWt: 2, grossWt: 2 })).status, 200);
  scans.delete('scan-sita-dropped');
  const rewrite = nextHistoryWrite();
  const repriced = await calculate(people.sita, 'scan-sita-dropped', { netWt: 4, grossWt: 4 });
  assert.equal(repriced.status, 200);
  assert.equal((await rewrite).written, true);
  const line = await ScanHistory.findOne({ scanId: 'scan-sita-dropped' }).lean();
  assert.equal(line.finalMRP, repriced.body.data.finalMRPRounded);

  // Another account naming that id without a record reaches nothing.
  const foreign = nextHistoryWrite();
  assert.equal((await calculate(people.ravi, 'scan-sita-dropped', { netWt: 9, grossWt: 9 })).status, 200);
  assert.equal((await foreign).written, false);
  assert.equal((await ScanHistory.findOne({ scanId: 'scan-sita-dropped' }).lean()).finalMRP, line.finalMRP);
  assert.equal(await ScanHistory.countDocuments({ scanId: 'scan-sita-dropped' }), 1);
});

test("a History open reads the lines it shows, not the whole shop's", async () => {
  const busyShop = new mongoose.Types.ObjectId();
  const ownerId = String(new mongoose.Types.ObjectId());
  const clerkId = String(new mongoose.Types.ObjectId());
  const start = Date.now() - 60 * 60 * 1000;
  await ScanHistory.insertMany(Array.from({ length: 400 }, (_, i) => ({
    businessId: busyShop,
    userId: i % 2 ? clerkId : ownerId,
    scanId: `busy-${i}`,
    itemName: '22K Gold',
    karat: '22K',
    finalMRP: 1000 + i,
    // Pairs priced in the same millisecond, so the tie-break is in play.
    createdAt: new Date(start + Math.floor(i / 2) * 1000),
  })));

  for (const [label, user] of [
    ['owner', { businessId: busyShop, userId: ownerId, role: 'OWNER' }],
    ['employee', { businessId: busyShop, userId: clerkId, role: 'EMP' }],
  ]) {
    const explained = await scanHistory.scansQuery(user, { limit: 30 }).explain('executionStats');
    const { queryPlanner, executionStats } = Array.isArray(explained) ? explained[0] : explained;
    const plan = JSON.stringify(queryPlanner.winningPlan);
    assert.doesNotMatch(plan, /"stage":"SORT"/, `${label}: ordered by an index, not sorted in memory`);
    assert.equal(executionStats.nReturned, 30, label);
    assert.ok(executionStats.totalDocsExamined <= 30, `${label}: read ${executionStats.totalDocsExamined} lines for 30`);
  }

  // And the order is the one the index keeps: newest first, ties by id.
  const listed = await scanHistory.listScans({ businessId: busyShop, userId: ownerId, role: 'OWNER' }, { limit: 4 });
  const expected = await ScanHistory.find({ businessId: busyShop }).lean();
  const byIdDescending = (a, b) => {
    if (String(a._id) === String(b._id)) return 0;
    return String(a._id) < String(b._id) ? 1 : -1;
  };
  expected.sort((a, b) => (b.createdAt - a.createdAt) || byIdDescending(a, b));
  assert.deepEqual(listed.map((item) => item.scanId), expected.slice(0, 4).map((line) => line.scanId));
});

test('a history write that fails never fails the price', async () => {
  const originalUpdateOne = ScanHistory.updateOne;
  let attempted;
  const writeAttempted = new Promise((resolve) => { attempted = resolve; });
  ScanHistory.updateOne = async () => {
    attempted();
    throw new Error('disk full');
  };
  try {
    const priced = await price(people.owner, 'scan-owner-broken', { netWt: 5, grossWt: 5 }, { settle: false });
    assert.equal(priced.status, 200, JSON.stringify(priced.body));
    assert.equal(priced.body.success, true);
    assert.ok(priced.body.data.finalMRPRounded > 0, 'the price is answered as ever');
    await writeAttempted;
  } finally {
    ScanHistory.updateOne = originalUpdateOne;
  }
  assert.equal(await ScanHistory.countDocuments({ scanId: 'scan-owner-broken' }), 0);
});

test('a price for a scan the caller cannot see writes nothing', async () => {
  scans.set('scan-of-ravi', {
    scanId: 'scan-of-ravi',
    ownerUserId: String(people.ravi.userId),
    businessId: String(shop.id),
    status: 'READY_FOR_REVIEW',
    calculationMode: 'rtgs',
  });
  const refused = await api('POST', '/scans/scan-of-ravi/calculate', {
    token: tokenOf(people.sita),
    body: { jewelleryType: 'Gold', purityKarat: '22K', netWt: 5, grossWt: 5 },
  });
  assert.equal(refused.status, 403);
  assert.equal(await ScanHistory.countDocuments({ scanId: 'scan-of-ravi' }), 0);
});

test('lines expire after 180 days, and leave with the account that made them', async () => {
  const indexes = await ScanHistory.collection.indexes();
  const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined);
  assert.deepEqual(ttl?.key, { createdAt: 1 });
  assert.equal(ttl.expireAfterSeconds, 180 * 24 * 60 * 60);

  await accountDeletionService.deleteAccount({ businessId: shop.id, userId: String(people.ravi.userId), role: 'EMP' });
  assert.equal(await ScanHistory.countDocuments({ userId: String(people.ravi.userId) }), 0, "the employee's own lines go");
  assert.ok(await ScanHistory.countDocuments({ businessId: shop.id }) > 0, "the rest of the shop's stay");

  await accountDeletionService.deleteAccount({ businessId: shop.id, userId: String(people.owner.userId), role: 'OWNER' });
  assert.equal(await ScanHistory.countDocuments({ businessId: shop.id }), 0, "the shop's go with the shop");
  assert.equal(await ScanHistory.countDocuments({ businessId: otherShop.id }), 1, "another shop's are untouched");
});

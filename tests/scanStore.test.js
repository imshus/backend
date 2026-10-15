/**
 * Scan records held in this process (SCAN_STORE=memory, the default) rather
 * than in Redis, and dropped once the scan is over:
 *  - a scan, start to price, makes no Redis round trip at all (the client is
 *    stood in for and counted); SCAN_STORE=redis is the old path, unchanged;
 *  - every read is a copy, as a Redis read was;
 *  - superseded by the same person's newer scan, or invoiced: dropped after a
 *    short grace that a request in flight outlasts; a session nothing was
 *    read into is not finished by an invoice;
 *  - idle 30 minutes: dropped (on read, and by the sweeper); a hard cap;
 *  - an unknown or dropped scan id is 404 SCAN_EXPIRED, "Please scan again",
 *    on the analysis, the review card and the calculation alike.
 * This file sets SCAN_STORE itself, so the suite does not depend on it.
 */
process.env.USE_MEMORY_STORE = 'false';
process.env.SCAN_STORE = 'memory';
process.env.SCAN_STORE_MAX_ENTRIES = '50';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// The Redis client, stood in for and counted: nothing here reaches a server.
const redisCalls = [];
const fakeRedis = (() => {
  const data = new Map();
  const counted = (name, fn) => async (...args) => {
    redisCalls.push(`${name} ${args[0]}`);
    return fn(...args);
  };
  return {
    get: counted('get', (key) => (data.has(key) ? data.get(key) : null)),
    set: counted('set', (key, value) => {
      data.set(key, String(value));
      return 'OK';
    }),
    del: counted('del', (...keys) => keys.filter((key) => data.delete(key)).length),
    incr: counted('incr', (key) => {
      const next = Number(data.get(key) || 0) + 1;
      data.set(key, String(next));
      return next;
    }),
    expire: counted('expire', () => 1),
    keys: counted('keys', () => [...data.keys()]),
  };
})();
const clientPath = require.resolve(path.join(__dirname, '..', 'src', 'redis', 'redisClient.js'));
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: fakeRedis };

const redisService = require('../src/services/redis.service');
const scanStore = require('../src/services/scanStore');
const scanService = require('../src/services/scan.service');
const openaiService = require('../src/services/openai.service');
const ocrPreprocessCache = require('../src/services/ocrPreprocess.cache');
const scanBillingService = require('../src/services/scanBilling.service');
const rateCalculationService = require('../src/services/rateCalculation.service');
const calculationController = require('../src/controllers/calculation.controller');
const LabourRate = require('../src/models/labourRate.model');
const errorHandler = require('../src/middleware/errorHandler');

const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpscan-store-'));
const OWNER = { userId: 'u1', businessId: 'b1', role: 'OWNER' };

const original = {
  analyzeImages: openaiService.analyzeImages,
  beginWarm: ocrPreprocessCache.beginWarm,
  billCompletedScan: scanBillingService.billCompletedScan,
  getLiveGoldRates: rateCalculationService.getLiveGoldRates,
  labourFindOne: LabourRate.findOne,
  now: Date.now,
};

test.before(() => {
  openaiService.analyzeImages = async () => ({
    provider: 'openai-test',
    structuredData: { grossWeight: { value: '8.208', confidence: 97 }, karat: { value: '18K', confidence: 90 } },
    unknownFields: [],
  });
  ocrPreprocessCache.beginWarm = () => ({ commit() {}, discard() {} });
  scanBillingService.billCompletedScan = async () => ({ totalScanCharge: 1, billedAt: new Date() });
  rateCalculationService.getLiveGoldRates = async () => ({
    karatRates: [{ carat: '18Kt', purity: 75 }],
    taxSettings: { rtgsFinalRate: 150000, cashFinalRate: 149000 },
  });
  LabourRate.findOne = async () => null;
});

test.after(() => {
  openaiService.analyzeImages = original.analyzeImages;
  ocrPreprocessCache.beginWarm = original.beginWarm;
  scanBillingService.billCompletedScan = original.billCompletedScan;
  rateCalculationService.getLiveGoldRates = original.getLiveGoldRates;
  LabourRate.findOne = original.labourFindOne;
  Date.now = original.now;
  scanStore.__internal.stopSweeper();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const quietly = async (fn) => {
  const { info, log } = console;
  console.info = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.info = info;
    console.log = log;
  }
};

let fileCount = 0;
const photo = () => {
  fileCount += 1;
  const file = path.join(tmpDir, `tag-${fileCount}.jpg`);
  fs.writeFileSync(file, 'jpeg');
  return file;
};

/** The error handler's answer for an error, as the app receives it. */
const answerFor = (error) => {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const { error: logError } = console;
  console.error = () => {};
  try {
    errorHandler(error, {}, res, () => {});
  } finally {
    console.error = logError;
  }
  return res;
};

const calculate = async (scanId, user = OWNER) => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  let failure = null;
  await calculationController.calculateMRP(
    {
      params: { scanId },
      user,
      body: { jewelleryType: 'GOLD', netWt: 10, grossWt: 10, purityKarat: '18K', diamonds: [], colorstones: [], otherCharges: 0, calculationMode: 'rtgs' },
    },
    res,
    (error) => { failure = error; },
  );
  return { res, failure };
};

/** One scan, start to price, as the app makes it. */
const fullScan = async (user = OWNER) => {
  const created = await scanService.createScan('GOLD', 'SINGLE_SIDE', user);
  await scanService.saveImage(created.scanId, photo(), 'front', user, {});
  const analyzed = await scanService.analyzeScan(created.scanId, {}, user.businessId, user);
  // The background billing writes the record once more; let it land.
  for (let i = 0; i < 200; i += 1) {
    const scan = await redisService.getScan(created.scanId);
    if (scan?.billing && !scan.billing.pending) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const review = await scanService.getReviewData(created.scanId, user);
  const priced = await calculate(created.scanId, user);
  return { scanId: created.scanId, analyzed, review, priced };
};

test('a scan, start to price, makes no Redis round trip; SCAN_STORE=redis is the old path', async () => {
  redisCalls.length = 0;
  const memory = await quietly(() => fullScan());
  assert.equal(memory.analyzed.status, 'ANALYSIS_COMPLETED');
  assert.equal(memory.review.structuredData.grossWeight, '8.208');
  assert.equal(memory.priced.failure, null);
  assert.ok(memory.priced.res.body.data.finalMRP > 0);
  assert.deepEqual(redisCalls, [], 'no Redis call anywhere on the scan path');

  process.env.SCAN_STORE = 'redis';
  try {
    const before = redisCalls.length;
    const viaRedis = await quietly(() => fullScan({ userId: 'u-redis', businessId: 'b1', role: 'OWNER' }));
    assert.equal(viaRedis.analyzed.status, 'ANALYSIS_COMPLETED');
    assert.ok(viaRedis.priced.res.body.data.finalMRP > 0);
    assert.ok(redisCalls.slice(before).some((call) => call.startsWith(`get scan:${viaRedis.scanId}`)));
    assert.equal(scanStore.peek(viaRedis.scanId), null, 'nothing of it is held in memory');
  } finally {
    process.env.SCAN_STORE = 'memory';
  }
});

test('every read is a copy: changing what was read changes nothing stored', async () => {
  await redisService.setScan('copy-1', { scanId: 'copy-1', status: 'WAITING_FOR_SCAN', nested: { a: 1 } });
  const first = await redisService.getScan('copy-1');
  first.nested.a = 2;
  first.status = 'TAMPERED';
  const second = await redisService.getScan('copy-1');
  assert.equal(second.nested.a, 1);
  assert.equal(second.status, 'WAITING_FOR_SCAN');
  assert.notEqual(first, second);
});

test('a newer scan by the same person finishes the old one: kept for a short grace, then dropped', async () => {
  const user = { userId: 'u-supersede', businessId: 'b1', role: 'OWNER' };
  const old = await quietly(() => fullScan(user));
  const t0 = Date.now();
  const next = await quietly(() => scanService.createScan('GOLD', 'SINGLE_SIDE', user));

  // Still readable at once: a request in flight on it completes.
  const held = await redisService.getScan(old.scanId);
  assert.equal(held.status, 'SUPERSEDED');
  assert.equal(held.calculation, null);
  assert.equal(await redisService.getLatestScanIdForUser('b1', 'u-supersede'), next.scanId);

  // Untouched past the grace: gone, and its id answers SCAN_EXPIRED.
  Date.now = () => t0 + scanStore.limits.FINISHED_GRACE_MS + 1000;
  try {
    assert.equal(await quietly(() => redisService.getScan(old.scanId)), null);
    const refused = await quietly(() => scanService.getReviewData(old.scanId, user).catch((error) => error));
    assert.equal(refused.statusCode, 404);
    assert.equal(refused.message, 'SCAN_EXPIRED');
    // The new scan is not finished by any of this.
    assert.equal((await redisService.getScan(next.scanId)).status, 'WAITING_FOR_SCAN');
  } finally {
    Date.now = original.now;
  }
});

test('an invoice finishes the scan it was made from, never an empty session', async () => {
  const user = { userId: 'u-invoice', businessId: 'b1', role: 'OWNER' };
  const sold = await quietly(() => fullScan(user));
  assert.equal(await quietly(() => redisService.finishLatestAnalyzedScan('b1', 'u-invoice', 'invoice')), true);
  assert.ok(scanStore.__internal.entry(sold.scanId).finishedAt, 'finished');

  // The scanner opened a session for the next piece; an invoice made now
  // (from the old card) must not take that session away from the next photo.
  const session = await quietly(() => scanService.createScan('GOLD', 'SINGLE_SIDE', user));
  assert.equal(await quietly(() => redisService.finishLatestAnalyzedScan('b1', 'u-invoice', 'invoice')), false);
  assert.equal(scanStore.__internal.entry(session.scanId).finishedAt, null);
});

test('idle for 30 minutes: dropped on read and by the sweeper; the newest are kept under the cap', async () => {
  const t0 = Date.now();
  await redisService.setScan('idle-1', { scanId: 'idle-1', status: 'WAITING_FOR_SCAN' });
  await redisService.setScan('idle-2', { scanId: 'idle-2', status: 'WAITING_FOR_SCAN' });
  try {
    Date.now = () => t0 + scanStore.limits.IDLE_MS - 1000;
    assert.ok(await redisService.getScan('idle-1'), 'touched just in time: kept, and its clock restarts');
    Date.now = () => t0 + scanStore.limits.IDLE_MS + 1000;
    assert.ok(await redisService.getScan('idle-1'));
    assert.equal(await quietly(() => redisService.getScan('idle-2')), null);

    Date.now = () => t0 + (2 * scanStore.limits.IDLE_MS) + 5000;
    await quietly(() => scanStore.sweep());
    assert.equal(scanStore.__internal.entry('idle-1'), null, 'the sweeper drops what nobody reads');
  } finally {
    Date.now = original.now;
  }

  scanStore.__internal.reset();
  for (let i = 0; i < scanStore.limits.MAX_ENTRIES + 5; i += 1) {
    await quietly(() => redisService.setScan(`cap-${i}`, { scanId: `cap-${i}` }));
  }
  assert.equal(scanStore.size(), scanStore.limits.MAX_ENTRIES);
  assert.equal(scanStore.peek('cap-0'), null, 'the least recently used went first');
  assert.ok(scanStore.peek(`cap-${scanStore.limits.MAX_ENTRIES + 4}`));
});

test('an unknown or dropped scan id is 404 SCAN_EXPIRED, "Please scan again", wherever it is used', async () => {
  const expired = 'no-such-scan';
  const failures = [
    await scanService.analyzeScan(expired, {}, 'b1', OWNER).catch((error) => error),
    await scanService.getReviewData(expired, OWNER).catch((error) => error),
    await scanService.saveImage(expired, photo(), 'front', OWNER, {}).catch((error) => error),
    (await quietly(() => calculate(expired, { userId: 'u-nobody', businessId: 'b1', role: 'OWNER' }))).failure,
  ];
  for (const failure of failures) {
    const answer = answerFor(failure);
    assert.equal(answer.statusCode, 404);
    assert.deepEqual(answer.body, {
      success: false,
      error: 'SCAN_EXPIRED',
      message: 'Scan not found or expired. Please scan again.',
    });
    // The words every build's review card already reads as a stale scan.
    assert.match(answer.body.message, /scan not found/i);
  }
});

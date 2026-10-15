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
 *    the empty session the scanner opens ahead of the photo is kept 24 hours;
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

const stubbedRates = async () => ({
  karatRates: [{ carat: '18Kt', purity: 75 }],
  taxSettings: { rtgsFinalRate: 150000, cashFinalRate: 149000 },
});

test.before(() => {
  openaiService.analyzeImages = async () => ({
    provider: 'openai-test',
    structuredData: { grossWeight: { value: '8.208', confidence: 97 }, karat: { value: '18K', confidence: 90 } },
    unknownFields: [],
  });
  ocrPreprocessCache.beginWarm = () => ({ commit() {}, discard() {} });
  scanBillingService.billCompletedScan = async () => ({ totalScanCharge: 1, billedAt: new Date() });
  rateCalculationService.getLiveGoldRates = stubbedRates;
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

/** What the review card sends: every input a price needs. */
const CARD = { jewelleryType: 'GOLD', netWt: 10, grossWt: 10, purityKarat: '18K', diamonds: [], colorstones: [], otherCharges: 0, calculationMode: 'rtgs' };

const calculate = async (scanId, user = OWNER, body = CARD) => {
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
      body,
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
  await redisService.setScan('idle-1', { scanId: 'idle-1', status: 'FRONT_IMAGE_RECEIVED', frontImagePath: photo() });
  await redisService.setScan('idle-2', { scanId: 'idle-2', status: 'ANALYSIS_COMPLETED', analysisResult: { structuredData: {} } });
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
    // Empty sessions: the cap holds them too, long-lived as they are.
    await quietly(() => redisService.setScan(`cap-${i}`, { scanId: `cap-${i}`, status: 'WAITING_FOR_SCAN' }));
  }
  assert.equal(scanStore.size(), scanStore.limits.MAX_ENTRIES);
  assert.equal(scanStore.peek('cap-0'), null, 'the least recently used went first');
  assert.ok(scanStore.peek(`cap-${scanStore.limits.MAX_ENTRIES + 4}`));
});

test('the session the scanner opens outlasts a quiet half hour; once a photo is in, the 30 minutes apply', async () => {
  const user = { userId: 'u-quiet', businessId: 'b1', role: 'OWNER' };
  const t0 = Date.now();
  const session = await quietly(() => scanService.createScan('GOLD', 'SINGLE_SIDE', user));
  try {
    // The capture screen sat open (or the phone locked) for 31 minutes.
    Date.now = () => t0 + scanStore.limits.IDLE_MS + 60 * 1000;
    await quietly(() => scanStore.sweep());
    assert.ok(scanStore.__internal.entry(session.scanId), 'the sweeper keeps an empty session');
    const saved = await quietly(() => scanService.saveImage(session.scanId, photo(), 'front', user, {}));
    assert.equal(saved.status, 'FRONT_IMAGE_RECEIVED', 'the next photo goes into it');
    assert.equal(await redisService.getLatestScanIdForUser('b1', 'u-quiet'), session.scanId);

    // With a photo in it, it is a scan in progress: 30 idle minutes drop it.
    Date.now = () => t0 + (2 * scanStore.limits.IDLE_MS) + 2 * 60 * 1000;
    await quietly(() => scanStore.sweep());
    assert.equal(scanStore.__internal.entry(session.scanId), null);

    // An empty session nobody comes back to goes after the old Redis TTL.
    const t1 = Date.now();
    const forgotten = await quietly(() => scanService.createScan('GOLD', 'SINGLE_SIDE', user));
    Date.now = () => t1 + scanStore.limits.EMPTY_SESSION_MS - 1000;
    await quietly(() => scanStore.sweep());
    assert.ok(scanStore.__internal.entry(forgotten.scanId));
    Date.now = () => t1 + scanStore.limits.EMPTY_SESSION_MS + 1000;
    await quietly(() => scanStore.sweep());
    assert.equal(scanStore.__internal.entry(forgotten.scanId), null);
  } finally {
    Date.now = original.now;
  }
});

test('an unknown or dropped scan id is 404 SCAN_EXPIRED, "Please scan again", on the scan itself', async () => {
  const expired = 'no-such-scan';
  const failures = [
    await scanService.analyzeScan(expired, {}, 'b1', OWNER).catch((error) => error),
    await scanService.getReviewData(expired, OWNER).catch((error) => error),
    await scanService.saveImage(expired, photo(), 'front', OWNER, {}).catch((error) => error),
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

test('a card whose scan was dropped while it sat open is still priced, from its own inputs, with nothing written', async () => {
  const user = { userId: 'u-haggle', businessId: 'b1', role: 'OWNER' };
  const sold = await quietly(() => fullScan(user));
  const t0 = Date.now();
  try {
    // A 35-minute negotiation, then the shop edits the net weight.
    Date.now = () => t0 + scanStore.limits.IDLE_MS + 5 * 60 * 1000;
    await quietly(() => scanStore.sweep());
    assert.equal(scanStore.__internal.entry(sold.scanId), null, 'the record is gone');

    const edited = await quietly(() => calculate(sold.scanId, user, { ...CARD, netWt: 12 }));
    assert.equal(edited.failure, null, 'not a 404 the card would ignore');
    assert.equal(edited.res.statusCode, 200);
    assert.ok(edited.res.body.data.finalMRP > sold.priced.res.body.data.finalMRP, 'the new weight is priced');
    assert.equal(scanStore.__internal.entry(sold.scanId), null, 'and no record is made up for it');

    // The card's cash/RTGS choice when it sends one; the shop's scanner
    // setting when it does not (the record's own choice is gone with it).
    rateCalculationService.getLiveGoldRates = async () => ({
      karatRates: [{ carat: '18Kt', purity: 75 }],
      taxSettings: { rtgsFinalRate: 150000, cashFinalRate: 149000, scannerCalculationUse: 'cash' },
    });
    const { calculationMode, ...noMode } = CARD;
    assert.equal(calculationMode, 'rtgs');
    const shopSetting = await quietly(() => calculate(sold.scanId, user, noMode));
    assert.equal(shopSetting.res.body.data.breakdown.goldRateApplied, 14900, 'the shop prices on cash');
    const cardChoice = await quietly(() => calculate(sold.scanId, user, CARD));
    assert.equal(cardChoice.res.body.data.breakdown.goldRateApplied, 15000, 'the card asked for RTGS');
  } finally {
    Date.now = original.now;
    rateCalculationService.getLiveGoldRates = stubbedRates;
  }
});

test('a dropped scan\'s card never prices against, or writes into, the same person\'s newer scan', async () => {
  const user = { userId: 'u-two-phones', businessId: 'b1', role: 'OWNER' };
  const first = await quietly(() => fullScan(user));
  // The same login opens the scanner again (another phone, or back to capture).
  const second = await quietly(() => fullScan(user));
  const secondBefore = await redisService.getScan(second.scanId);
  assert.equal(await redisService.getLatestScanIdForUser('b1', 'u-two-phones'), second.scanId);

  const t0 = Date.now();
  try {
    // Past the grace a superseded scan gets; the newer one is read on its own phone.
    Date.now = () => t0 + scanStore.limits.FINISHED_GRACE_MS + 1000;
    assert.ok(await redisService.getScan(second.scanId));
    const late = await quietly(() => calculate(first.scanId, user, { ...CARD, netWt: 3, calculationMode: 'cash' }));
    assert.equal(late.failure, null, 'priced from the card it came from');
    assert.equal(late.res.statusCode, 200);
    await new Promise((resolve) => setImmediate(resolve));

    const secondAfter = await redisService.getScan(second.scanId);
    assert.deepEqual(secondAfter.calculation, secondBefore.calculation, 'the newer scan\'s figures are untouched');
    assert.deepEqual(secondAfter.calculationInputSnapshot, secondBefore.calculationInputSnapshot);
    assert.equal(secondAfter.calculationMode, secondBefore.calculationMode, 'and so is its cash/RTGS choice');
    assert.equal(secondAfter.status, secondBefore.status);
  } finally {
    Date.now = original.now;
  }
});

test('SCAN_STORE=redis: a missing scan is 404 SCAN_EXPIRED on the calculation, as before', async () => {
  process.env.SCAN_STORE = 'redis';
  try {
    const { failure } = await quietly(() => calculate('no-such-scan', { userId: 'u-nobody', businessId: 'b1', role: 'OWNER' }));
    const answer = answerFor(failure);
    assert.equal(answer.statusCode, 404);
    assert.equal(answer.body.error, 'SCAN_EXPIRED');
  } finally {
    process.env.SCAN_STORE = 'memory';
  }
});

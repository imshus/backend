/**
 * Where a scan's wait goes, measured per analyzed scan:
 *  - one [SCAN_TIMING] JSON line per analyzed scan, with exactly the agreed
 *    fields and nothing about the shop or the tag;
 *  - a window of the last 200, reported by GET /api/v1/health as scanTiming
 *    { count, p50Ms, p95Ms, maxMs, overTargetPct } against SCAN_TARGET_MS
 *    (4000 by default);
 *  - a finished scan asked again is not a new timing.
 * The analysis and the price's reads are stood in for.
 */
process.env.USE_MEMORY_STORE = 'true';
process.env.SCAN_STORE = 'memory';
delete process.env.SCAN_TARGET_MS;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const scanTiming = require('../src/services/scanTiming');
const scanService = require('../src/services/scan.service');
const scanController = require('../src/controllers/scan.controller');
const openaiService = require('../src/services/openai.service');
const ocrPreprocessCache = require('../src/services/ocrPreprocess.cache');
const scanBillingService = require('../src/services/scanBilling.service');
const mrpCalculation = require('../src/services/mrpCalculation.service');
const rateCalculationService = require('../src/services/rateCalculation.service');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpscan-timing-'));
const OWNER = { userId: 'u-time', businessId: 'b-time', role: 'OWNER' };
const FIELDS = [
  'scanId', 'totalMs', 'headStartMs', 'rotationMs', 'readMs', 'adjudicationMs', 'pricingMs',
  'storeMs', 'reads', 'images', 'tier', 'model', 'speculativeUsed',
];

const lines = [];
const original = {
  info: console.info,
  analyzeImages: openaiService.analyzeImages,
  beginWarm: ocrPreprocessCache.beginWarm,
  billCompletedScan: scanBillingService.billCompletedScan,
  getLiveGoldRates: rateCalculationService.getLiveGoldRates,
};

test.before(() => {
  console.info = (tag, ...rest) => {
    if (tag === '[SCAN_TIMING]') lines.push(JSON.parse(rest[0]));
  };
  openaiService.analyzeImages = async () => {
    const result = {
      provider: 'openai-test',
      structuredData: { grossWeight: { value: '8.208', confidence: 97 }, karat: { value: '18K', confidence: 90 } },
      unknownFields: [],
    };
    Object.defineProperty(result, 'timing', {
      value: { preprocessMs: 40, rotationMs: 900, readMs: 2100, adjudicationMs: 0, reads: 2, images: 9, tier: 'priority', model: 'gpt-test', rotationReread: false },
      enumerable: false,
    });
    return result;
  };
  ocrPreprocessCache.beginWarm = () => ({ commit() {}, discard() {} });
  scanBillingService.billCompletedScan = async () => null;
  // The price fails fast (no database here); the scan still answers.
  rateCalculationService.getLiveGoldRates = async () => {
    throw Object.assign(new Error('no rate'), { code: 'RATES_UNAVAILABLE', statusCode: 503 });
  };
});

test.after(() => {
  console.info = original.info;
  openaiService.analyzeImages = original.analyzeImages;
  ocrPreprocessCache.beginWarm = original.beginWarm;
  scanBillingService.billCompletedScan = original.billCompletedScan;
  rateCalculationService.getLiveGoldRates = original.getLiveGoldRates;
  require('../src/services/scanStore').__internal.stopSweeper();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const analyzeThroughController = async (scanId) => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  let failure = null;
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    await scanController.analyzeScan(
      { params: { scanId }, user: OWNER, body: {}, headers: {}, get: () => undefined },
      res,
      (error) => { failure = error; },
    );
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return { res, failure };
};

test('one [SCAN_TIMING] line per analyzed scan, with exactly the agreed fields and no PII', async () => {
  // Stand-ins for the price's database reads (prefetchPricingReads).
  const models = ['diamondRate', 'colorstoneRate', 'wastageCode', 'labourCode', 'itemCode'].map((name) => require(`../src/models/${name}.model`));
  const singles = ['goldTaxSetting', 'labourRate'].map((name) => require(`../src/models/${name}.model`));
  const saved = [...models.map((m) => m.find), ...singles.map((m) => m.findOne)];
  for (const model of models) model.find = async () => [];
  for (const model of singles) model.findOne = async () => null;
  try {
    lines.length = 0;
    const { scanId } = await scanService.createScan('GOLD', 'SINGLE_SIDE', OWNER);
    const file = path.join(tmpDir, 'tag.jpg');
    fs.writeFileSync(file, 'jpeg');
    await scanService.saveImage(scanId, file, 'front', OWNER, {});

    const { res, failure } = await analyzeThroughController(scanId);
    assert.equal(failure, null);
    assert.equal(res.body.success, true);
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.deepEqual(Object.keys(line), FIELDS);
    assert.equal(line.scanId, scanId);
    assert.ok(line.totalMs >= 0);
    assert.equal(line.rotationMs, 900);
    assert.equal(line.readMs, 2100);
    assert.equal(line.reads, 2);
    assert.equal(line.images, 9);
    assert.equal(line.tier, 'priority');
    assert.equal(line.model, 'gpt-test');
    assert.equal(line.speculativeUsed, false);
    assert.equal(line.headStartMs, 0);
    assert.ok(line.storeMs >= 0 && line.pricingMs >= 0);
    // Nothing that names the shop, the person or the tag.
    const text = JSON.stringify(line);
    for (const leak of [OWNER.businessId, OWNER.userId, '8.208', file]) assert.ok(!text.includes(leak), leak);
    assert.ok(!('timing' in res.body.data), 'the response is unchanged');

    // The same scan asked again answers from the record: not a new timing.
    await analyzeThroughController(scanId);
    assert.equal(lines.length, 1);
  } finally {
    models.forEach((model, index) => { model.find = saved[index]; });
    singles.forEach((model, index) => { model.findOne = saved[models.length + index]; });
  }
});

test('the window keeps the last 200 and reports p50, p95, max and the share over 4 s', () => {
  scanTiming.__internal.reset();
  assert.deepEqual(scanTiming.scanTimingSummary(), {
    count: 0, p50Ms: null, p95Ms: null, maxMs: null, overTargetPct: null, targetMs: 4000,
  });
  // 1..250 s worth of 100 ms steps: only the last 200 (5,100..25,000 ms) stay.
  for (let i = 1; i <= 250; i += 1) scanTiming.recordScanTiming({ scanId: `s${i}`, totalMs: i * 100 });
  const window = scanTiming.scanTimingSummary();
  assert.equal(window.count, 200);
  assert.equal(window.maxMs, 25000);
  assert.equal(window.p50Ms, 15000);
  assert.equal(window.p95Ms, 24000);
  assert.equal(window.overTargetPct, 100);

  scanTiming.__internal.reset();
  for (const ms of [2500, 3100, 3900, 4200, 6000]) scanTiming.recordScanTiming({ scanId: 'x', totalMs: ms });
  assert.equal(scanTiming.scanTimingSummary().overTargetPct, 40);
  assert.equal(scanTiming.scanTimingSummary().p50Ms, 3900);
  process.env.SCAN_TARGET_MS = '5000';
  try {
    assert.equal(scanTiming.scanTimingSummary().overTargetPct, 20);
    assert.equal(scanTiming.scanTimingSummary().targetMs, 5000);
  } finally {
    delete process.env.SCAN_TARGET_MS;
  }
});

test('GET /api/v1/health reports the window as scanTiming', async () => {
  scanTiming.__internal.reset();
  for (const ms of [3000, 5000]) scanTiming.recordScanTiming({ scanId: 'h', totalMs: ms });
  const { log } = console;
  console.log = () => {};
  const app = require('../src/app');
  console.log = log;
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/v1/health', agent: false }, (response) => {
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => resolve(JSON.parse(raw)));
      }).on('error', reject);
    });
    assert.equal(body.status, 'healthy');
    assert.deepEqual(body.scanTiming, {
      count: 2, p50Ms: 3000, p95Ms: 5000, maxMs: 5000, overTargetPct: 50, targetMs: 4000,
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

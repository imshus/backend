/**
 * The per-10 g rates getLiveGoldRates works out, from the October 2026
 * calculation audit (#7, #10, #39):
 *   - RTGS, cash and each karat row are whole rupees, commercial half-up on
 *     the decimal the figure stands for: 1,53,452.50 is 1,53,453, cash
 *     1,53,252.50 is 1,53,253 (it was kept unrounded), and 1,20,125 at 91.6%
 *     (1,10,034.50) is 1,10,035 (the float product rounded down);
 *   - with no board MCX and no stored MCX there is no rate at all
 *     (RATES_UNAVAILABLE), where it used to be worked out on Rs 1,60,000.
 * The real mcx.service and rateCalculation.service; the feed, Redis and the
 * database are stood in for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'rateCalculation.service.js');
const SERVICE_DIR = path.dirname(SERVICE);
const CONTROLLERS = path.join(__dirname, '..', 'src', 'controllers');

const state = {
  mcx: 152340,
  houseMcx: 152340,
  bhaw: { cashBhaw: 900, rtgsBhaw: 1100, name: 'JMD Patil' },
  tax: null,
  karatRows: [
    { carat: '22Kt', purity: 91.6 },
    { carat: '20Kt', purity: 85 },
    { carat: '18Kt', purity: 75 },
    { carat: '14Kt', purity: 58.5 },
    { carat: '9Kt', purity: 39 },
  ],
  cacheWrites: 0,
};

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: SERVICE, filename: SERVICE, paths: Module._nodeModulePaths(SERVICE_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('./redis.service', {
  getMcxCache: async () => state.mcx,
  getGoldRatesCache: async () => null,
  setGoldRatesCache: async () => { state.cacheWrites += 1; },
  getSupremeCache: async () => ({ rtgsChange: 0, cashChange: 0 }),
  getGoldRatesGeneration: async () => 0,
  bumpGoldRatesGeneration: async () => {},
  invalidateGoldRatesCache: async () => {},
});
stub('./bhaw.service', {
  SOURCES: { JMD_PATIL: 'jmd_patil', MEGA_BULLION: 'mega_bullion' },
  SOURCE_NAMES: { jmd_patil: 'JMD Patil', mega_bullion: 'Mega Bullion' },
  prefetch: async () => null,
  getBhawForSource: async () => state.bhaw,
  houseMcxSell: async () => state.houseMcx,
  feedStamp: async () => 'off',
});
stub('../models/goldTaxSetting.model', { findOne: async (query) => (query.userId ? null : state.tax) });
function GoldRateStub(doc) { Object.assign(this, doc); }
GoldRateStub.prototype.save = async function save() { return this; };
GoldRateStub.find = async () => state.karatRows.map((row) => ({ ...row, increaseByAmount: 0 }));
stub('../models/goldRate.model', GoldRateStub);
stub('../models/supremeChange.model', { findOne: () => ({ sort: async () => null }) });
stub('../models/dashboardMetrics.model', { findOne: async () => null });
stub('../models/bullionSource.model', { findOne: async () => null });

const { getLiveGoldRates } = require(SERVICE);
const mcxService = require(path.join(SERVICE_DIR, 'mcx.service.js'));
const rateController = require(path.join(CONTROLLERS, 'rate.controller.js'));

const BIZ = '507f1f77bcf86cd799439011';

const reset = (overrides = {}) => {
  Object.assign(state, {
    mcx: 152340,
    houseMcx: 152340,
    bhaw: { cashBhaw: 900, rtgsBhaw: 1100, name: 'JMD Patil' },
    tax: null,
    cacheWrites: 0,
  }, overrides);
};

const quietly = async (fn) => {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
};

test('#10 RTGS and cash are whole rupees, half-up: a shop change of Rs 12.50 lands on .50 and goes up', async () => {
  reset({ tax: { rtgsChangeBy: 12.5, cashChangeBy: 12.5, scannerCalculationUse: 'rtgs' } });
  const rates = await getLiveGoldRates(BIZ);
  // 1,52,340 + 1,100 + 12.50 and 1,52,340 + 900 + 12.50.
  assert.equal(rates.taxSettings.rtgsRate1FinalRate, 153453);
  assert.equal(rates.taxSettings.rtgsFinalRate, 153453);
  assert.equal(rates.taxSettings.cashFinalRate, 153253, 'cash used to be kept at 1,53,252.50');
});

test('#10 RTGS Rate 2 is worked out in paise: the board figure less the Tax box percent, half-up', async () => {
  // 1,45,600.52 / 1.04 is 1,40,000.50 exactly; the float quotient is
  // 140000.49999999997, which Math.round took down.
  reset({
    houseMcx: 144500,
    tax: { rtgsChangeBy: 0.52, rtgsTaxPercent: 4, rtgsVariant: 'plain', scannerCalculationUse: 'rtgs' },
  });
  let rates = await getLiveGoldRates(BIZ);
  assert.equal(rates.taxSettings.rtgsRate1FinalRate, 145601);
  assert.equal(rates.taxSettings.rtgsRate2FinalRate, 140001);
  assert.equal(rates.taxSettings.rtgsFinalRate, 140001);
  // Off a tie: 1,53,450 / 1.03 = 1,48,980.58...
  reset({ tax: { rtgsTaxPercent: 3, rtgsVariant: 'plain', scannerCalculationUse: 'rtgs' } });
  state.bhaw = { cashBhaw: 0, rtgsBhaw: 1110, name: 'JMD Patil' };
  rates = await getLiveGoldRates(BIZ);
  assert.equal(rates.taxSettings.rtgsRate2FinalRate, 148981);
});

test('#39 a karat row is rate × purity to the rupee, half-up: 1,20,125 at 91.6% is 1,10,035', async () => {
  reset({ houseMcx: 118000 });
  state.bhaw = { cashBhaw: 2125, rtgsBhaw: 2125, name: 'JMD Patil' };
  const rates = await getLiveGoldRates(BIZ);
  assert.equal(rates.taxSettings.rtgsFinalRate, 120125);
  const k22 = rates.karatRates.find((row) => row.carat === '22Kt');
  assert.equal(Math.round(120125 * (91.6 / 100)), 110034, 'the float product rounds down');
  assert.equal(k22.rtgsRate, 110035);
  assert.equal(k22.cashRate, 110035);
  // Rows off a tie are unchanged: 1,18,000 MCX at 75%.
  assert.equal(rates.karatRates.find((row) => row.carat === '18Kt').mcxRate, 88500);
});

test('#7 with no stored MCX the MCX service answers null, never Rs 1,60,000', async () => {
  reset({ mcx: null });
  assert.equal(await quietly(() => mcxService.getLiveMcxRate24K()), null);
  reset({ mcx: 152340 });
  assert.equal(await mcxService.getLiveMcxRate24K(), 152340);
});

test('#7 no board MCX and no stored MCX: RATES_UNAVAILABLE, nothing cached, and GET /rates/gold says so', async () => {
  reset({ mcx: null, houseMcx: null, bhaw: null });
  await assert.rejects(quietly(() => getLiveGoldRates(BIZ)), (error) => {
    assert.equal(error.code, 'RATES_UNAVAILABLE');
    assert.equal(error.statusCode, 503);
    return true;
  });
  assert.equal(state.cacheWrites, 0);

  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await quietly(() => rateController.getGoldRates({ user: { businessId: BIZ, role: 'OWNER', userId: 'u1' } }, res));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'RATES_UNAVAILABLE');
});

test('#7 either MCX is enough: the board line with no stored MCX, or the stored MCX with no board line', async () => {
  reset({ mcx: null, houseMcx: 150000 });
  let rates = await quietly(() => getLiveGoldRates(BIZ));
  assert.equal(rates.taxSettings.rtgsFinalRate, 151100);
  assert.equal(rates.mcxLiveRate, 150000, 'the board line stands in for the market MCX shown');
  reset({ mcx: 149000, houseMcx: null });
  rates = await getLiveGoldRates(BIZ);
  assert.equal(rates.taxSettings.rtgsFinalRate, 150100);
});

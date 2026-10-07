/**
 * Pins the bhaw-vendor contract for the gold rates the app displays:
 *
 *   cash rate = house MCX sell + its cash premium + business cash change
 *   rtgs rate = house MCX sell + its rtgs premium + business rtgs change
 *
 * where the premium is the house's own Cash/RTGS sell less its MCX sell, off
 * the same record — so with no business change the rate is the house's own
 * sell. The feed's cash_bhaw/rtgs_bhaw (the tracker's diff from the MCX buy)
 * runs above the premium by the MCX spread and is not what is added.
 *
 * The vendor comes from the Dashboard Settings toggle (bhaw_source_jmd), the
 * bhaw values from the live feed, and the response always carries bhawSource
 * so Home and Gold Rate Settings can label what they are showing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'rateCalculation.service.js');
const SERVICE_DIR = path.dirname(SERVICE);

const MCX_LIVE = 155000;
const MCX_BUY = MCX_LIVE - 30;

/** A house quoting MCX_LIVE (buy 30 below) with these premiums on it. */
const house = (source, name, cashPremium, rtgsPremium) => ({
  source,
  name,
  // The tracker's diffs: side sell less the MCX buy.
  cash_bhaw: String(MCX_LIVE + cashPremium - MCX_BUY),
  rtgs_bhaw: String(MCX_LIVE + rtgsPremium - MCX_BUY),
  rows: [
    { label: 'Gold Future MCX', buy: String(MCX_BUY), sell: String(MCX_LIVE) },
    { label: '99.50 Gold Cash', buy: String(MCX_LIVE + cashPremium - 1000), sell: String(MCX_LIVE + cashPremium) },
    { label: '99.50 Gold RTGS', buy: String(MCX_LIVE + rtgsPremium - 1500), sell: String(MCX_LIVE + rtgsPremium) },
  ],
});

const state = {
  useJmd: false,
  cached: null,
  cacheWrites: [],
  feed: [
    house('jmd_patil', 'JMD Patil', -3200, 4800),
    house('mega_bullion', 'Mega Bullion', -3900, 4900),
  ],
};

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: SERVICE, filename: SERVICE, paths: Module._nodeModulePaths(SERVICE_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('./mcx.service', { getLiveMcxRate24K: async () => MCX_LIVE });
stub('../models/goldTaxSetting.model', {
  findOne: async () => ({
    mcxChange: { operation: '+', amount: 0 },
    rtgsChangeBy: 200,
    cashChangeBy: -100,
    scannerCalculationUse: 'rtgs',
  }),
});
function GoldRateStub(doc) { Object.assign(this, doc); }
GoldRateStub.prototype.save = async function save() { return this; };
GoldRateStub.find = async () => [{ karat: 22, purity: 91.6, save: async () => {} }];
stub('../models/goldRate.model', GoldRateStub);
stub('./redis.service', {
  getGoldRatesCache: async () => state.cached,
  setGoldRatesCache: async (businessId, data) => { state.cacheWrites.push(data); },
  getSupremeCache: async () => null,
  getGoldRatesGeneration: async () => 0,
  bumpGoldRatesGeneration: async () => {},
});
stub('../models/supremeChange.model', {
  // Distinctive stored fallback: if these leak into results, the live feed
  // was not used.
  findOne: () => ({ sort: async () => ({ rtgsChange: 111, cashChange: -111 }) }),
});
stub('../models/dashboardMetrics.model', {
  findOne: async () => ({ metricsData: { bhaw_source_jmd: state.useJmd } }),
});

// axios is what bhaw.service uses for the live feed.
const axiosResolved = Module._resolveFilename('axios', {
  id: SERVICE, filename: SERVICE, paths: Module._nodeModulePaths(SERVICE_DIR),
});
require.cache[axiosResolved] = {
  id: axiosResolved, filename: axiosResolved, loaded: true,
  exports: { get: async () => ({ data: state.feed }) },
};

const { getLiveGoldRates } = require(SERVICE);
const { RUNNING_COMMIT } = require(path.join(SERVICE_DIR, '..', 'utils', 'runningCommit.js'));

const BUSINESS_ID = '507f1f77bcf86cd799439011';

const reset = () => {
  state.cached = null;
  state.cacheWrites = [];
};

test('selecting JMD Patil applies its live cash and rtgs bhaw to the MCX rate', async () => {
  reset();
  state.useJmd = true;
  const result = await getLiveGoldRates(BUSINESS_ID);

  assert.equal(result.bhawSource.key, 'jmd_patil');
  assert.equal(result.bhawSource.name, 'JMD Patil');
  assert.equal(result.bhawSource.live, true);
  // The premium over JMD's MCX sell, not the tracker's -3170 / 4830.
  assert.equal(result.supremeChanges.cashChange, -3200);
  assert.equal(result.supremeChanges.rtgsChange, 4800);
  // final = house MCX sell + its premium + business change
  assert.equal(result.taxSettings.cashFinalRate, MCX_LIVE - 3200 - 100);
  // Rate 1 = board + 3%; the fixture ticks Rate 2 = the board figure itself (Tax box never saved, so 0).
  // Rate 1 is the board figure itself, no tax on it, and it is the one ticked.
  assert.equal(result.taxSettings.rtgsRate1FinalRate, MCX_LIVE + 4800 + 200);
  assert.equal(result.taxSettings.rtgsFinalRate, MCX_LIVE + 4800 + 200);
});

test('selecting Mega Bullion applies its bhaw instead', async () => {
  reset();
  state.useJmd = false;
  const result = await getLiveGoldRates(BUSINESS_ID);

  assert.equal(result.bhawSource.key, 'mega_bullion');
  assert.equal(result.supremeChanges.cashChange, -3900);
  assert.equal(result.supremeChanges.rtgsChange, 4900);
  assert.equal(result.taxSettings.cashFinalRate, MCX_LIVE - 3900 - 100);
  assert.equal(result.taxSettings.rtgsFinalRate, MCX_LIVE + 4900 + 200);
});

test('the stored supreme-change fallback is not used while the feed is live', async () => {
  reset();
  state.useJmd = false;
  const result = await getLiveGoldRates(BUSINESS_ID);
  assert.notEqual(result.supremeChanges.rtgsChange, 111);
  assert.notEqual(result.supremeChanges.cashChange, -111);
});

test('a cached response from a pre-vendor build is recomputed, not served', async () => {
  reset();
  state.useJmd = true;
  // What an old deployment left in Redis: no bhawSource, stale numbers.
  state.cached = {
    mcxLiveRate: 140000,
    supremeChanges: { rtgsChange: 9100, cashChange: -5900 },
  };

  const result = await getLiveGoldRates(BUSINESS_ID);

  assert.ok(result.bhawSource, 'recomputed response must carry bhawSource');
  assert.equal(result.mcxLiveRate, MCX_LIVE, 'stale cached MCX must not be served');
  assert.equal(result.supremeChanges.cashChange, -3200);
  assert.equal(state.cacheWrites.length, 1, 'the fresh result should be cached');
});

test('a cached response from the current build is served as-is', async () => {
  reset();
  state.cached = {
    mcxLiveRate: 154000,
    bhawSource: { key: 'jmd_patil', name: 'JMD Patil', live: true },
    supremeChanges: { rtgsChange: 4800, cashChange: -3200 },
    // The feed as it was when this was computed — and still is.
    feedStamp: `${MCX_LIVE}|-3200|4800`,
    // Worked out by this same deployment.
    build: RUNNING_COMMIT,
  };

  const result = await getLiveGoldRates(BUSINESS_ID);
  assert.equal(result.mcxLiveRate, 154000);
  assert.equal(state.cacheWrites.length, 0, 'no recompute on a valid cache hit');
});

/**
 * Scans are priced the way Home and Gold Rate Settings show: a house counts
 * as live only when it has published both bhaw sides (the feed sends null
 * for the rest), every house on the feed can be followed, and a cached rate
 * is dropped once the board has moved or a save landed while it computed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'rateCalculation.service.js');
const SERVICE_DIR = path.dirname(SERVICE);

const MCX = 150720;
const JMD_LINE = 153273;
// What each house charges, straight off its own board: its MCX sell plus a
// fixed premium (JMD Cash -3,100, RTGS +2,100; Shri Sai RTGS +4,450).
const JMD_CASH_SELL = JMD_LINE - 3100;
const JMD_RTGS_SELL = JMD_LINE + 2100;
const SAI_RTGS_SELL = MCX + 4450;

/**
 * A house as the 3-minute feed carries it: the three rows, and the tracker's
 * Badla Bhaw (cash_bhaw / rtgs_bhaw), which is the side's sell less the MCX
 * *buy*, so it sits above the premium by the MCX spread.
 */
const house = (source, name, mcxBuy, mcxSell, cashSell, rtgsSell, rtgsBuy = null) => ({
  source,
  name,
  cash_bhaw: cashSell === null ? null : String(cashSell - mcxBuy),
  rtgs_bhaw: rtgsSell === null ? null : String(rtgsSell - mcxBuy),
  rows: [
    { label: 'Gold Future MCX', buy: String(mcxBuy), sell: String(mcxSell) },
    { label: '99.50 Gold Cash', buy: null, sell: cashSell === null ? null : String(cashSell) },
    { label: '99.50 Gold RTGS', buy: rtgsBuy, sell: rtgsSell === null ? null : String(rtgsSell) },
  ],
});

// The feed on Sunday 27 Sep 2026: JMD on December with both sides, Shri Sai
// with RTGS only, Mega and Shri Ganesh silent. JMD's MCX spread is 27, Shri
// Sai's 20: the tracker's diffs read -3073 / 2127 and 4470.
const FEED = [
  house('jmd_patil', 'JMD Patil', JMD_LINE - 27, JMD_LINE, JMD_CASH_SELL, JMD_RTGS_SELL),
  house('mega_bullion', 'Mega Bullion', MCX - 20, MCX, null, null),
  house('shri_sai', 'Shri Sai Jewels', MCX - 20, MCX, null, SAI_RTGS_SELL, '-'),
  house('shri_ganesh', 'Shri Ganesh Bullion', MCX - 20, MCX, null, null),
];

const state = {
  selected: 'jmd_patil',
  cached: null,
  writes: [],
  generation: 0,
  // Bumped mid-compute by a test to stand in for a save landing.
  bumpDuringCompute: false,
};

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: SERVICE, filename: SERVICE, paths: Module._nodeModulePaths(SERVICE_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('./mcx.service', { getLiveMcxRate24K: async () => MCX });
stub('../models/goldTaxSetting.model', {
  findOne: async () => ({
    mcxChange: { operation: '+', amount: 500 },
    rtgsChangeBy: 200,
    cashChangeBy: -100,
    scannerCalculationUse: 'rtgs',
    rtgsTaxPercent: 3,
    rtgsVariant: 'plain',
  }),
});
function GoldRateStub(doc) { Object.assign(this, doc); }
GoldRateStub.prototype.save = async function save() { return this; };
GoldRateStub.find = async () => [{ carat: '22Kt', purity: 91.6, save: async () => {} }];
stub('../models/goldRate.model', GoldRateStub);
stub('./redis.service', {
  getGoldRatesCache: async () => state.cached,
  setGoldRatesCache: async (id, data) => { state.writes.push(data); },
  getSupremeCache: async () => null,
  getGoldRatesGeneration: async () => {
    if (state.bumpDuringCompute) { state.bumpDuringCompute = false; return state.generation; }
    return state.generation;
  },
  bumpGoldRatesGeneration: async () => { state.generation += 1; },
});
stub('../models/supremeChange.model', {
  findOne: () => ({ sort: async () => ({ rtgsChange: 111, cashChange: -111 }) }),
});
stub('../models/dashboardMetrics.model', {
  findOne: async () => ({ metricsData: { bhaw_source_jmd: state.selected === 'jmd_patil' } }),
});
stub('../models/bullionSource.model', {
  findOne: () => {
    const doc = () => ({ selected: state.selected });
    const chain = { lean: async () => doc(), sort: () => chain, then: (ok, ko) => Promise.resolve(doc()).then(ok, ko) };
    return chain;
  },
});
const axiosResolved = Module._resolveFilename('axios', {
  id: SERVICE, filename: SERVICE, paths: Module._nodeModulePaths(SERVICE_DIR),
});
require.cache[axiosResolved] = {
  id: axiosResolved, filename: axiosResolved, loaded: true,
  exports: { get: async () => ({ data: FEED }) },
};

const bhawService = require(path.join(SERVICE_DIR, 'bhaw.service.js'));
const { RUNNING_COMMIT } = require(path.join(SERVICE_DIR, '..', 'utils', 'runningCommit.js'));
const { getLiveGoldRates } = require(SERVICE);
const BIZ = '507f1f77bcf86cd799439011';
const reset = (selected) => { state.selected = selected; state.cached = null; state.writes = []; };

test('each bhaw side stands on its own: a silent house is null, a one-sided house keeps its side', async () => {
  assert.equal(await bhawService.getBhawForSource('mega_bullion'), null, 'no side published');
  // The premium over the house's own MCX sell, not the tracker's diff from
  // the MCX buy (4470, -3073 / 2127).
  assert.deepEqual(await bhawService.getBhawForSource('shri_sai'), {
    cashBhaw: null, rtgsBhaw: 4450, name: 'Shri Sai Jewels',
  }, 'RTGS published, cash not: never a cash of 0');
  assert.deepEqual(await bhawService.getBhawForSource('jmd_patil'), {
    cashBhaw: -3100, rtgsBhaw: 2100, name: 'JMD Patil',
  });
});

test('Shri Sai follower: RTGS off its own board, Retail on the stored fallback', async () => {
  reset('shri_sai');
  const r = await getLiveGoldRates(BIZ);
  assert.equal(r.bhawSource.live, true);
  assert.equal(r.taxSettings.pricingMcxLiveRate, MCX, 'its own line, 150720');
  // RTGS Rate 1 = line + mcxChange + its RTGS premium + rtgsChangeBy:
  // 150720 + 500 + 4450 + 200 — the board RTGS 155170 plus the changes, no tax.
  assert.equal(r.taxSettings.rtgsRate1FinalRate, SAI_RTGS_SELL + 500 + 200);
  // Retail: no cash side, so the stored fallback (-111) for that side only.
  assert.equal(r.taxSettings.cashFinalRate, MCX + 500 - 111 - 100);
  assert.equal(r.feedStamp, `${MCX}|null|4450`);
  assert.equal(await bhawService.feedStamp('shri_sai'), r.feedStamp, 'the stamp the cache is checked against');
});

test('JMD follower: Retail and the ticked RTGS as Gold Rate Settings shows them', async () => {
  reset('jmd_patil');
  const r = await getLiveGoldRates(BIZ);
  assert.equal(r.bhawSource.key, 'jmd_patil');
  assert.equal(r.bhawSource.live, true);
  assert.equal(r.taxSettings.pricingMcxLiveRate, JMD_LINE);
  // Retail = house line + mcxChange + cash premium + cashChangeBy: JMD's
  // own Cash sell plus the shop's changes.
  assert.equal(r.taxSettings.cashFinalRate, JMD_CASH_SELL + 500 - 100);
  // RTGS Rate 1 = house line + mcxChange + rtgs premium + rtgsChangeBy, no tax.
  // Rate 2 (without tax) = Rate 1's figure divided by 1 + the Tax box (3
  // here, so 1.03); it is ticked.
  const board = JMD_RTGS_SELL + 500 + 200;
  assert.equal(r.taxSettings.rtgsRate1FinalRate, board, 'Rate 1 is the board figure, no tax');
  assert.equal(r.taxSettings.rtgsRate2FinalRate, Math.round(board / 1.03));
  assert.equal(r.taxSettings.rtgsFinalRate, Math.round(board / 1.03));
  assert.equal(r.feedStamp, `${JMD_LINE}|-3100|2100`);
  assert.equal(await bhawService.feedStamp('jmd_patil'), r.feedStamp, 'the stamp the cache is checked against');
});

test('a silent house is priced on the stored change over the market MCX, and says so', async () => {
  reset('mega_bullion');
  const r = await getLiveGoldRates(BIZ);
  assert.equal(r.bhawSource.key, 'mega_bullion');
  assert.equal(r.bhawSource.live, false);
  assert.equal(r.bhawSource.name, 'Mega Bullion');
  assert.equal(r.taxSettings.pricingMcxLiveRate, MCX);
  assert.equal(r.taxSettings.cashFinalRate, MCX + 500 - 111 - 100);
  assert.equal(r.taxSettings.rtgsRate1FinalRate, MCX + 500 + 111 + 200);
  assert.equal(r.feedStamp, 'off');
});

test('Shri Sai and Shri Ganesh can be followed on the server', async () => {
  reset('shri_sai');
  const sai = await getLiveGoldRates(BIZ);
  assert.equal(sai.bhawSource.key, 'shri_sai');
  assert.equal(sai.bhawSource.name, 'Shri Sai Jewels');
  reset('shri_ganesh');
  const ganesh = await getLiveGoldRates(BIZ);
  assert.equal(ganesh.bhawSource.key, 'shri_ganesh');
  assert.equal(ganesh.bhawSource.name, 'Shri Ganesh Bullion');
});

test('a Tax box saved at 0 prices Rate 2 at Rate 1 itself; 4 divides it by 1.04', async () => {
  reset('jmd_patil');
  const taxModel = require('../src/models/goldTaxSetting.model');
  const original = taxModel.findOne;
  taxModel.findOne = async () => ({
    mcxChange: { operation: '+', amount: 0 },
    rtgsChangeBy: 0,
    cashChangeBy: 0,
    scannerCalculationUse: 'rtgs',
    rtgsTaxPercent: 0,
    rtgsVariant: 'plain',
  });
  try {
    const r = await getLiveGoldRates(BIZ);
    const board = JMD_RTGS_SELL;
    assert.equal(r.taxSettings.rtgsRate2FinalRate, board, 'saved 0 means 0: Rate 1 as it is');
    assert.equal(r.taxSettings.rtgsFinalRate, board, 'Rate 2 ticked, so that is what a scan charges');
    assert.equal(r.taxSettings.rtgsTaxPercent, 0);

    taxModel.findOne = async () => ({
      mcxChange: { operation: '+', amount: 0 },
      rtgsChangeBy: 0,
      cashChangeBy: 0,
      scannerCalculationUse: 'rtgs',
      rtgsTaxPercent: 4,
      rtgsVariant: 'plain',
    });
    state.cached = null;
    const four = await getLiveGoldRates(BIZ);
    assert.equal(four.taxSettings.rtgsRate2FinalRate, Math.round(JMD_RTGS_SELL / 1.04), '4 in the box divides by 1.04');
  } finally {
    taxModel.findOne = original;
  }
});

test('a cached rate is served while the board reads the same, dropped once it moves', async () => {
  reset('jmd_patil');
  state.cached = {
    mcxLiveRate: 1, bhawSource: { key: 'jmd_patil', name: 'JMD Patil', live: true },
    feedStamp: `${JMD_LINE}|-3100|2100`, build: RUNNING_COMMIT,
  };
  assert.equal((await getLiveGoldRates(BIZ)).mcxLiveRate, 1, 'same board: served');
  assert.equal(state.writes.length, 0);

  state.cached = { ...state.cached, feedStamp: `${JMD_LINE}|-3000|2100` };
  assert.equal((await getLiveGoldRates(BIZ)).mcxLiveRate, MCX, 'bhaw moved: recomputed');
  assert.equal(state.writes.length, 1);
});

test('a cached rate from another deployment is worked out again, not served', async () => {
  reset('jmd_patil');
  const board = { bhawSource: { key: 'jmd_patil', name: 'JMD Patil', live: true }, feedStamp: `${JMD_LINE}|-3100|2100` };
  // Written by the deployment before this one (its rules read a saved 0 as
  // 3), and by one too old to stamp its build at all.
  for (const stale of [{ ...board, mcxLiveRate: 1, build: 'an-older-commit' }, { ...board, mcxLiveRate: 1 }]) {
    state.cached = stale;
    state.writes = [];
    const r = await getLiveGoldRates(BIZ);
    assert.equal(r.mcxLiveRate, MCX, 'recomputed under the rules of this deployment');
    assert.equal(r.build, RUNNING_COMMIT);
    assert.equal(state.writes.length, 1, 'and cached again, stamped with this build');
  }
});

test('a save landing mid-compute keeps that compute out of the cache', async () => {
  reset('jmd_patil');
  const original = bhawService.getBhawForSource;
  // A save arrives while the feed is being read.
  bhawService.getBhawForSource = async (source) => { state.generation += 1; return original(source); };
  try {
    const r = await getLiveGoldRates(BIZ);
    assert.equal(r.bhawSource.key, 'jmd_patil');
    assert.equal(state.writes.length, 0, 'the older settings must not be cached');
  } finally {
    bhawService.getBhawForSource = original;
  }
});

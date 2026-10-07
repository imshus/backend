/**
 * The market MCX is the figure most bullion houses agree on, and a house's
 * RTGS/Cash stand on that house's own MCX line.
 *
 * The houses do not all quote the same contract. On 25 Sep 2026 the feed had
 * JMD Patil's "Gold Future MCX" on the December contract (154,261) and the
 * other three on the October near month (151,920). Taking the first house,
 * as the server used to, put December on every shop's MCX.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'rateCalculation.service.js');
const SERVICE_DIR = path.dirname(SERVICE);

const JMD_DEC = 154261;
const NEAR_MONTH = 151920;
// What JMD charges: its own (December) MCX sell plus a fixed premium.
const JMD_CASH_SELL = JMD_DEC - 3000;
const JMD_RTGS_SELL = JMD_DEC + 1900;

// The live feed's shape, as seen on 25 Sep 2026 (explicit nulls included):
// each house's three rows, and the tracker's diffs (side sell less the MCX
// buy, so above the premium by the MCX spread: 52 on JMD's December line).
const FEED = [
  {
    source: 'jmd_patil', name: 'JMD Patil', cash_bhaw: String(JMD_CASH_SELL - 154209), rtgs_bhaw: String(JMD_RTGS_SELL - 154209),
    rows: [
      { label: 'Gold Future MCX', buy: '154209', sell: String(JMD_DEC) },
      { label: '99.50 Gold Cash', buy: String(JMD_CASH_SELL - 1000), sell: String(JMD_CASH_SELL) },
      { label: '99.50 Gold RTGS', buy: String(JMD_RTGS_SELL - 1500), sell: String(JMD_RTGS_SELL) },
    ],
  },
  {
    source: 'mega_bullion', name: 'Mega Bullion', cash_bhaw: null, rtgs_bhaw: null,
    rows: [
      { label: 'Gold Future MCX', buy: '151902', sell: String(NEAR_MONTH) },
      { label: '99.50 Gold Cash', buy: null, sell: null },
      { label: '99.50 Gold RTGS', buy: null, sell: null },
    ],
  },
  {
    source: 'shri_sai', name: 'Shri Sai Jewels', cash_bhaw: null, rtgs_bhaw: String(NEAR_MONTH + 4270 - 151902),
    rows: [
      { label: 'Gold Future MCX', buy: '151902', sell: String(NEAR_MONTH) },
      { label: '99.50 Gold Cash', buy: null, sell: null },
      { label: '99.50 Gold RTGS', buy: '-', sell: String(NEAR_MONTH + 4270) },
    ],
  },
  {
    source: 'shri_ganesh', name: 'Shri Ganesh Bullion', cash_bhaw: null, rtgs_bhaw: null,
    rows: [
      { label: 'Gold Future MCX', buy: '151902', sell: String(NEAR_MONTH) },
      { label: '99.50 Gold Cash', buy: null, sell: null },
      { label: '99.50 Gold RTGS', buy: null, sell: null },
    ],
  },
];

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: SERVICE, filename: SERVICE, paths: Module._nodeModulePaths(SERVICE_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

// The scheduler stores the board's majority figure as the live MCX.
stub('./mcx.service', { getLiveMcxRate24K: async () => NEAR_MONTH });
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
  getGoldRatesCache: async () => null,
  setGoldRatesCache: async () => {},
  getSupremeCache: async () => null,
  getGoldRatesGeneration: async () => 0,
  bumpGoldRatesGeneration: async () => {},
});
stub('../models/supremeChange.model', {
  findOne: () => ({ sort: async () => ({ rtgsChange: 111, cashChange: -111 }) }),
});
stub('../models/dashboardMetrics.model', {
  findOne: async () => ({ metricsData: { bhaw_source_jmd: true } }),
});
// The shop follows JMD Patil (and no database is reached for it).
stub('../models/bullionSource.model', {
  findOne: () => {
    const doc = { selected: 'jmd_patil' };
    const chain = { lean: async () => doc, sort: () => chain, then: (ok, ko) => Promise.resolve(doc).then(ok, ko) };
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
const { getLiveGoldRates } = require(SERVICE);

test('majorityMcx: three houses on the near month outvote one on December', () => {
  assert.equal(bhawService.majorityMcx([JMD_DEC, NEAR_MONTH, NEAR_MONTH, NEAR_MONTH]), NEAR_MONTH);
});

test('majorityMcx: quotes of one contract a few rupees apart count as one group', () => {
  assert.equal(bhawService.majorityMcx([151902, 151920, 151969, 154261]), 151920);
});

test('majorityMcx: a 2-2 split goes to the lower contract, never an average of the two', () => {
  const result = bhawService.majorityMcx([154261, 154284, 151920, 151969]);
  assert.equal(result, 151920);
});

test('majorityMcx: one stale low board cannot split a real cluster and win the tie', () => {
  // Three quotes within 200 of each other, one stale board 550 below them.
  assert.equal(bhawService.majorityMcx([151000, 151550, 151700, 151750]), 151700);
});

test('majorityMcx: a single house speaks alone; nothing gives null', () => {
  assert.equal(bhawService.majorityMcx([JMD_DEC]), JMD_DEC);
  assert.equal(bhawService.majorityMcx([]), null);
  assert.equal(bhawService.majorityMcx([0, NaN, -5, null, undefined]), null);
});

test('boardMcxSell is the majority, not the first house on the feed', async () => {
  assert.equal(await bhawService.boardMcxSell(), NEAR_MONTH);
});

test('houseMcxSell is that house\'s own line', async () => {
  assert.equal(await bhawService.houseMcxSell('jmd_patil'), JMD_DEC);
  assert.equal(await bhawService.houseMcxSell('mega_bullion'), NEAR_MONTH);
  assert.equal(await bhawService.houseMcxSell('no_such_house'), null);
});

test('a JMD shop: MCX shows the market figure, RTGS/Cash stay on JMD\'s own line', async () => {
  const result = await getLiveGoldRates('507f1f77bcf86cd799439011');
  // The scheduler's stored MCX is the market majority; the MCX the shop
  // sees is its own house's line (JMD's December figure), at the shop's asking.
  assert.equal(result.mcxLiveRate, NEAR_MONTH);
  assert.equal(result.taxSettings.mcxFinalRate, JMD_DEC);
  // JMD prices over its own (December) line, so the rate JMD charges — and
  // the one scans price on — is built there: its own sells plus the shop's
  // changes, not the tracker's diffs on that line (52 high, the spread).
  // Rate 1 ticked by default: the board figure itself.
  assert.equal(result.taxSettings.rtgsFinalRate, JMD_RTGS_SELL + 200);
  assert.equal(result.taxSettings.cashFinalRate, JMD_CASH_SELL - 100);
  assert.equal(result.supremeChanges.rtgsChange, 1900, 'the premium, not the diff (1952)');
  assert.equal(result.supremeChanges.cashChange, -3000, 'the premium, not the diff (-2948)');
  // And the app is told which MCX that was, for when its own feed is out.
  assert.equal(result.taxSettings.pricingMcxLiveRate, JMD_DEC);
});

test('houseMcxLines lists every house line for the scheduler to compare', async () => {
  assert.deepEqual(await bhawService.houseMcxLines(), {
    jmd_patil: JMD_DEC,
    mega_bullion: NEAR_MONTH,
    shri_sai: NEAR_MONTH,
    shri_ganesh: NEAR_MONTH,
  });
});

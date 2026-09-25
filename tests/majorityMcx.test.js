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

// The live feed's shape, as seen on 25 Sep 2026 (explicit nulls included).
const FEED = [
  {
    source: 'jmd_patil', name: 'JMD Patil', cash_bhaw: '-3000', rtgs_bhaw: '1900',
    rows: [{ label: 'Gold Future MCX', buy: '154209', sell: String(JMD_DEC) }],
  },
  {
    source: 'mega_bullion', name: 'Mega Bullion', cash_bhaw: null, rtgs_bhaw: null,
    rows: [{ label: 'Gold Future MCX', buy: '151902', sell: String(NEAR_MONTH) }],
  },
  {
    source: 'shri_sai', name: 'Shri Sai Jewels', cash_bhaw: null, rtgs_bhaw: '4270',
    rows: [{ label: 'Gold Future MCX', buy: '151902', sell: String(NEAR_MONTH) }],
  },
  {
    source: 'shri_ganesh', name: 'Shri Ganesh Bullion', cash_bhaw: null, rtgs_bhaw: null,
    rows: [{ label: 'Gold Future MCX', buy: '151902', sell: String(NEAR_MONTH) }],
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
});
stub('../models/supremeChange.model', {
  findOne: () => ({ sort: async () => ({ rtgsChange: 111, cashChange: -111 }) }),
});
stub('../models/dashboardMetrics.model', {
  findOne: async () => ({ metricsData: { bhaw_source_jmd: true } }),
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
  // The MCX shown is the market's.
  assert.equal(result.mcxLiveRate, NEAR_MONTH);
  assert.equal(result.taxSettings.mcxFinalRate, NEAR_MONTH);
  // JMD's bhaw is quoted over its own (December) line, so the rate JMD
  // charges — and the one scans price on — is built there.
  assert.equal(result.taxSettings.rtgsFinalRate, JMD_DEC + 1900 + 200);
  assert.equal(result.taxSettings.cashFinalRate, JMD_DEC - 3000 - 100);
});

/**
 * End to end on two real 3-minute snapshots (7 Oct 2026, 09:47:22 and
 * 09:50:22, verbatim in tests/fixtures): what GET /rates/gold answers and
 * the per-gram rate a scan is priced at are the house's own Cash and RTGS
 * sells, to the rupee — JMD Patil Cash 1,48,357 and RTGS 1,51,807 over its
 * MCX sell 1,49,557 (buy 1,49,530). The tracker's diffs on that board
 * (-1173 / 2277) on the MCX sell gave 1,48,384 / 1,51,834, 27 high.
 *
 * Only the feed, Redis and the database are stood in for; the controller,
 * the rate calculation, the board service and computeMrp are the real ones.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'src');
const SERVICES = path.join(SRC, 'services');
const BOARD_0947 = require('./fixtures/board3min-2026-10-07T0947.json');
const BOARD_0950 = require('./fixtures/board3min-2026-10-07T0950.json');

const state = {
  board: BOARD_0947,
  selected: 'jmd_patil',
  tax: null,
  cacheOn: false,
  cache: new Map(),
  writes: 0,
  mcx: null,
};

const resolveFromServices = (request) => Module._resolveFilename(request, {
  id: path.join(SERVICES, 'index.js'),
  filename: path.join(SERVICES, 'index.js'),
  paths: Module._nodeModulePaths(SERVICES),
});
const stub = (request, exports) => {
  const resolved = resolveFromServices(request);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

// The 3-minute feed answers with the snapshot itself (not a stream).
stub('axios', { get: async () => ({ data: state.board }) });
stub('./redis.service', {
  getGoldRatesCache: async (id) => (state.cacheOn ? state.cache.get(id) ?? null : null),
  setGoldRatesCache: async (id, data) => {
    state.writes += 1;
    state.cache.set(id, JSON.parse(JSON.stringify(data)));
  },
  getGoldRatesGeneration: async () => 0,
  bumpGoldRatesGeneration: async () => {},
  getSupremeCache: async () => null,
  getMcxCache: async () => state.mcx,
  getScan: async () => null,
  getLatestScanIdForUser: async () => null,
  getPromptCustomizations: async () => [],
  addPromptCustomization: async () => {},
});

const GoldRate = require(path.join(SRC, 'models', 'goldRate.model'));
const GoldTaxSetting = require(path.join(SRC, 'models', 'goldTaxSetting.model'));
const SupremeChange = require(path.join(SRC, 'models', 'supremeChange.model'));
const DashboardMetrics = require(path.join(SRC, 'models', 'dashboardMetrics.model'));
const BullionSource = require(path.join(SRC, 'models', 'bullionSource.model'));
const LabourRate = require(path.join(SRC, 'models', 'labourRate.model'));

const original = {
  goldRateFind: GoldRate.find,
  taxFindOne: GoldTaxSetting.findOne,
  supremeFindOne: SupremeChange.findOne,
  metricsFindOne: DashboardMetrics.findOne,
  bullionFindOne: BullionSource.findOne,
  labourFindOne: LabourRate.findOne,
};
GoldRate.find = async () => [
  { _id: '1', carat: '22Kt', purity: 91.6, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
  { _id: '2', carat: '20Kt', purity: 85, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
  { _id: '3', carat: '18Kt', purity: 75, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
  { _id: '4', carat: '14Kt', purity: 58.5, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
  { _id: '5', carat: '9Kt', purity: 39, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
];
// No saved settings: the defaults (no change of the shop's own).
GoldTaxSetting.findOne = async () => state.tax;
// A stored fallback of nothing, so a side the house does not quote shows.
SupremeChange.findOne = () => ({ sort: async () => ({ rtgsChange: 0, cashChange: 0 }) });
DashboardMetrics.findOne = async () => null;
BullionSource.findOne = async () => ({ selected: state.selected });
LabourRate.findOne = async () => null;

test.after(() => {
  GoldRate.find = original.goldRateFind;
  GoldTaxSetting.findOne = original.taxFindOne;
  SupremeChange.findOne = original.supremeFindOne;
  DashboardMetrics.findOne = original.metricsFindOne;
  BullionSource.findOne = original.bullionFindOne;
  LabourRate.findOne = original.labourFindOne;
});

const bhawService = require(path.join(SERVICES, 'bhaw.service.js'));
const rateController = require(path.join(SRC, 'controllers', 'rate.controller.js'));
const { computeMrp } = require(path.join(SERVICES, 'mrpCalculation.service.js'));

const BIZ = '507f1f77bcf86cd799439011';
const OWNER = { businessId: BIZ, role: 'OWNER', userId: '507f1f77bcf86cd799439012' };

/** A snapshot on the feed, as the next 3-minute read would bring it. */
const useBoard = async (board, selected = state.selected) => {
  state.board = board;
  state.selected = selected;
  bhawService.__internal.resetCache();
  // The scheduler stores the board's majority MCX (mcxScheduler.service.js).
  state.mcx = await bhawService.boardMcxSell();
};

/** GET /rates/gold through the real controller. */
const getGoldRates = async () => {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await rateController.getGoldRates({ user: OWNER }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.data;
};

/** The 24K per-gram rate computeMrp prices a scan at, in one mode. */
const perGram = async (mode) => {
  const { resultData } = await computeMrp({
    user: OWNER,
    sessionContext: null,
    scanId: null,
    input: { netWt: 10, purityKarat: '22K', calculationMode: mode, diamonds: [], colorstones: [] },
    scan: { calculationMode: mode },
  });
  return resultData.breakdown.goldRateApplied;
};

const toNum = (value) => {
  const text = String(value ?? '').replace(/,/g, '').trim();
  return text === '' || !Number.isFinite(Number(text)) ? null : Number(text);
};
/** A house's own sell on one row of the board, or null. */
const sellOn = (board, source, label) => {
  const vendor = board.sources.find((entry) => entry.source === source);
  return toNum(vendor.rows.find((row) => label.test(row.label))?.sell);
};

test('09:47:22, JMD Patil: GET /rates/gold and a scan price at JMD\'s own Cash and RTGS sells', async () => {
  await useBoard(BOARD_0947, 'jmd_patil');
  const data = await getGoldRates();
  const t = data.taxSettings;

  assert.equal(data.bhawSource.key, 'jmd_patil');
  assert.equal(data.bhawSource.live, true);
  // The MCX tile is unchanged: JMD's MCX sell plus the shop's change (none).
  assert.equal(t.mcxFinalRate, 149557);
  assert.equal(t.pricingMcxLiveRate, 149557);
  // Retail and RTGS: the dealer's own sells.
  assert.equal(t.cashFinalRate, 148357);
  assert.equal(t.rtgsRate1FinalRate, 151807);
  assert.equal(t.rtgsRate2FinalRate, 151807, 'Tax box never saved: 0, the board figure itself');
  assert.equal(t.rtgsFinalRate, 151807);
  assert.equal(t.cashFinalRate, sellOn(BOARD_0947, 'jmd_patil', /cash/i));
  assert.equal(t.rtgsFinalRate, sellOn(BOARD_0947, 'jmd_patil', /rtgs/i));
  // The premiums over that line, not the tracker's -1173 / 2277.
  assert.equal(data.supremeChanges.cashChange, -1200);
  assert.equal(data.supremeChanges.rtgsChange, 2250);
  // Karat rows are the same purity arithmetic on those figures.
  const k22 = data.rates.find((row) => row.carat === '22Kt');
  assert.equal(k22.rtgsRate, Math.round(151807 * 0.916));
  assert.equal(k22.cashRate, Math.round(148357 * 0.916));
  assert.equal(k22.mcxRate, Math.round(149557 * 0.916));

  // computeMrp: the 24K rate per gram is the 10 g sell over ten.
  assert.equal(await perGram('rtgs'), 151807 / 10);
  assert.equal(await perGram('cash'), 148357 / 10);
});

test('09:47:22, Shri Sai Jewels: RTGS at its own RTGS sell; no Cash on its board', async () => {
  await useBoard(BOARD_0947, 'shri_sai');
  const data = await getGoldRates();
  const t = data.taxSettings;
  assert.equal(data.bhawSource.live, true);
  assert.equal(t.rtgsRate1FinalRate, 151907);
  assert.equal(t.rtgsFinalRate, sellOn(BOARD_0947, 'shri_sai', /rtgs/i));
  assert.equal(data.supremeChanges.rtgsChange, 2350, 'not the tracker\'s 2377');
  // No Cash row on its board: the stored fallback (0 here) on its line.
  assert.equal(t.cashFinalRate, 149557);
  assert.equal(await perGram('rtgs'), 151907 / 10);
});

test('every live side on both snapshots prices at the house\'s own sell', async () => {
  for (const board of [BOARD_0947, BOARD_0950]) {
    for (const vendor of board.sources) {
      const cashSell = sellOn(board, vendor.source, /cash/i);
      const rtgsSell = sellOn(board, vendor.source, /rtgs/i);
      if (cashSell === null && rtgsSell === null) continue;
      await useBoard(board, vendor.source);
      const t = (await getGoldRates()).taxSettings;
      if (cashSell !== null) assert.equal(t.cashFinalRate, cashSell, `${vendor.source} Cash at ${board.fetched_at}`);
      if (rtgsSell !== null) assert.equal(t.rtgsFinalRate, rtgsSell, `${vendor.source} RTGS at ${board.fetched_at}`);
    }
  }
});

test('09:50:22: only the MCX buy moved, so the cached rate is still JMD\'s rate and is served', async () => {
  state.cacheOn = true;
  state.cache.clear();
  state.writes = 0;
  try {
    await useBoard(BOARD_0947, 'jmd_patil');
    const first = await getGoldRates();
    assert.equal(state.writes, 1);
    const stamp0947 = await bhawService.feedStamp('jmd_patil');
    assert.equal(stamp0947, '149557|-1200|2250');

    // Three minutes on: MCX buy 1,49,530 -> 1,49,531, the tracker's diffs
    // -1173 / 2277 -> -1174 / 2276; JMD's sells unchanged.
    await useBoard(BOARD_0950, 'jmd_patil');
    assert.equal(await bhawService.feedStamp('jmd_patil'), stamp0947);
    const second = await getGoldRates();
    assert.equal(state.writes, 1, 'served from the cache, not worked out again');
    assert.deepEqual(second, first);
    assert.equal(second.taxSettings.cashFinalRate, sellOn(BOARD_0950, 'jmd_patil', /cash/i));
    assert.equal(second.taxSettings.rtgsFinalRate, sellOn(BOARD_0950, 'jmd_patil', /rtgs/i));
  } finally {
    state.cacheOn = false;
    state.cache.clear();
  }
});

test('the shop\'s own changes still go on top as before', async () => {
  state.tax = {
    mcxChange: { operation: '+', amount: 100 },
    rtgsChangeBy: 50,
    cashChangeBy: -25,
    scannerCalculationUse: 'rtgs',
    rtgsTaxPercent: 3,
    rtgsVariant: 'plain',
  };
  try {
    await useBoard(BOARD_0947, 'jmd_patil');
    const t = (await getGoldRates()).taxSettings;
    assert.equal(t.mcxFinalRate, 149557 + 100);
    assert.equal(t.cashFinalRate, 148357 + 100 - 25);
    assert.equal(t.rtgsRate1FinalRate, 151807 + 100 + 50);
    assert.equal(t.rtgsRate2FinalRate, Math.round((151807 + 100 + 50) / 1.03));
    assert.equal(t.rtgsFinalRate, t.rtgsRate2FinalRate, 'Rate 2 ticked');
    assert.equal(await perGram('rtgs'), t.rtgsRate2FinalRate / 10);
  } finally {
    state.tax = null;
  }
});

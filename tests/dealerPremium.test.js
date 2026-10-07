/**
 * The bhaw the server adds to a house's MCX sell is that house's premium:
 * its Cash or RTGS sell less its "Gold Future MCX" sell, both off the same
 * record.
 *
 * The feed's cash_bhaw / rtgs_bhaw (diff1 / diff2) is the tracker's Badla
 * Bhaw, the side's sell less the MCX *buy*. The houses price Cash and RTGS
 * as the MCX *sell* plus a fixed premium, so that diff on the sell line came
 * out high by the MCX spread (3 to 46 rupees on 7 Oct 2026, never exact over
 * 1,275 live frames). With the premium, a shop with no changes of its own
 * prices at the house's own sell, to the rupee, whatever the spread.
 *
 * Fallbacks, in order: side sell - MCX sell; diff - (MCX sell - MCX buy),
 * the same figure; the raw diff (a feed that publishes only a bhaw); null
 * (the side is not live, and the stored fallback applies as before).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'rateCalculation.service.js');
const SERVICE_DIR = path.dirname(SERVICE);

/** The scheduler's stored MCX, used only for a house with no line. */
const MARKET_MCX = 150000;
const STORED = { rtgsChange: 111, cashChange: -111 };

const state = {
  board: [],
  selected: 'jmd_patil',
  cached: null,
  writes: [],
};

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: SERVICE, filename: SERVICE, paths: Module._nodeModulePaths(SERVICE_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('./mcx.service', { getLiveMcxRate24K: async () => MARKET_MCX });
// No change of the shop's own: MCX, Cash and RTGS as the house quotes them.
stub('../models/goldTaxSetting.model', {
  findOne: async () => ({
    mcxChange: { operation: '+', amount: 0 },
    rtgsChangeBy: 0,
    cashChangeBy: 0,
    scannerCalculationUse: 'rtgs',
  }),
});
function GoldRateStub(doc) { Object.assign(this, doc); }
GoldRateStub.prototype.save = async function save() { return this; };
GoldRateStub.find = async () => [
  { carat: '22Kt', purity: 91.6 }, { carat: '20Kt', purity: 85 }, { carat: '18Kt', purity: 75 },
  { carat: '14Kt', purity: 58.5 }, { carat: '9Kt', purity: 39 },
];
stub('../models/goldRate.model', GoldRateStub);
stub('./redis.service', {
  getGoldRatesCache: async () => state.cached,
  setGoldRatesCache: async (id, data) => { state.writes.push(data); },
  getSupremeCache: async () => null,
  getGoldRatesGeneration: async () => 0,
  bumpGoldRatesGeneration: async () => {},
});
stub('../models/supremeChange.model', {
  findOne: () => ({ sort: async () => STORED }),
});
stub('../models/dashboardMetrics.model', { findOne: async () => null });
stub('../models/bullionSource.model', { findOne: async () => ({ selected: state.selected }) });

// The 3-minute feed: a non-stream body is taken as the board itself.
const axiosResolved = Module._resolveFilename('axios', {
  id: SERVICE, filename: SERVICE, paths: Module._nodeModulePaths(SERVICE_DIR),
});
require.cache[axiosResolved] = {
  id: axiosResolved, filename: axiosResolved, loaded: true,
  exports: { get: async () => ({ data: state.board }) },
};

const bhawService = require(path.join(SERVICE_DIR, 'bhaw.service.js'));
const { RUNNING_COMMIT } = require(path.join(SERVICE_DIR, '..', 'utils', 'runningCommit.js'));
const { getLiveGoldRates } = require(SERVICE);

const BIZ = '507f1f77bcf86cd799439011';

/** Puts a board on the feed and drops the one held, as a new snapshot would. */
const useBoard = (board, selected = 'jmd_patil') => {
  state.board = board;
  state.selected = selected;
  state.cached = null;
  state.writes = [];
  bhawService.__internal.resetCache();
};

/**
 * One house as the tracker publishes it: the three rows, and its diffs,
 * side sell less MCX buy (lambda_function.py, diff1 / diff2). A side with
 * no sell is null on both.
 */
const house = ({ source = 'jmd_patil', mcxBuy, mcxSell, cashSell = null, rtgsSell = null }) => ({
  source,
  name: source,
  rows: [
    { label: 'Gold Future MCX', buy: String(mcxBuy), sell: String(mcxSell) },
    { label: '99.50 Gold Cash', buy: cashSell === null ? null : String(cashSell - 1000), sell: cashSell === null ? null : String(cashSell) },
    { label: '99.50 Gold RTGS', buy: rtgsSell === null ? null : '-', sell: rtgsSell === null ? null : String(rtgsSell) },
  ],
  diff1: cashSell === null ? null : cashSell - mcxBuy,
  diff2: rtgsSell === null ? null : rtgsSell - mcxBuy,
  cash_bhaw: cashSell === null ? null : cashSell - mcxBuy,
  rtgs_bhaw: rtgsSell === null ? null : rtgsSell - mcxBuy,
});

test('no shop change: Retail and RTGS are the house\'s own Cash and RTGS sells, whatever the MCX spread', async () => {
  // JMD Patil's premiums on 7 Oct 2026, and another pair; spreads from
  // none through the 3 to 46 seen live to a wide one.
  for (const [cashPremium, rtgsPremium] of [[-1200, 2250], [-3100, 2100]]) {
    for (const spread of [0, 3, 27, 46, 120]) {
      const mcxSell = 149557;
      const cashSell = mcxSell + cashPremium;
      const rtgsSell = mcxSell + rtgsPremium;
      useBoard([
        house({ mcxBuy: mcxSell - spread, mcxSell, cashSell, rtgsSell }),
        house({ source: 'shri_sai', mcxBuy: mcxSell - spread, mcxSell, rtgsSell: mcxSell + 2350 }),
      ]);
      const label = `premiums ${cashPremium}/${rtgsPremium}, spread ${spread}`;

      const jmd = await getLiveGoldRates(BIZ);
      assert.equal(jmd.taxSettings.cashFinalRate, cashSell, `Retail is JMD's Cash sell (${label})`);
      assert.equal(jmd.taxSettings.rtgsRate1FinalRate, rtgsSell, `RTGS Rate 1 is JMD's RTGS sell (${label})`);
      assert.equal(jmd.taxSettings.rtgsFinalRate, rtgsSell, `the RTGS a scan charges (${label})`);
      // The MCX tile is untouched: the house's MCX sell plus the shop's change (0).
      assert.equal(jmd.taxSettings.mcxFinalRate, mcxSell);
      assert.equal(jmd.supremeChanges.cashChange, cashPremium);
      assert.equal(jmd.supremeChanges.rtgsChange, rtgsPremium);

      useBoard(state.board, 'shri_sai');
      const sai = await getLiveGoldRates(BIZ);
      assert.equal(sai.taxSettings.rtgsRate1FinalRate, mcxSell + 2350, `RTGS is Shri Sai's RTGS sell (${label})`);
      assert.equal(sai.taxSettings.cashFinalRate, mcxSell + STORED.cashChange, 'no Cash on its board: the stored fallback');
    }
  }
});

test('the premium is the side sell less the MCX sell, off the same record, even when the diff disagrees', async () => {
  const record = house({ mcxBuy: 149530, mcxSell: 149557, cashSell: 148357, rtgsSell: 151807 });
  // A diff out of step with the rows (stale, or computed some other way):
  // the sells on the record are what the house charges.
  useBoard([{ ...record, cash_bhaw: -1100, rtgs_bhaw: 2300 }]);
  assert.deepEqual(await bhawService.getBhawForSource('jmd_patil'), { cashBhaw: -1200, rtgsBhaw: 2250, name: 'jmd_patil' });
});

test('no side sell: the diff less the MCX spread, the same figure', async () => {
  // The tracker's diffs (-1173 / 2277 over a 27 spread) with the side rows
  // missing, blank, '-' or absent altogether.
  const base = { source: 'jmd_patil', name: 'JMD Patil', cash_bhaw: -1173, rtgs_bhaw: '2,277' };
  const mcx = { label: 'Gold Future MCX', buy: '1,49,530', sell: '1,49,557' };
  for (const rows of [
    [mcx],
    [mcx, { label: '99.50 Gold Cash', buy: null, sell: null }, { label: '99.50 Gold RTGS', buy: null, sell: null }],
    [mcx, { label: '99.50 Gold Cash', buy: '-', sell: '-' }, { label: '99.50 Gold RTGS', buy: '', sell: '' }],
  ]) {
    useBoard([{ ...base, rows }]);
    assert.deepEqual(await bhawService.getBhawForSource('jmd_patil'), { cashBhaw: -1200, rtgsBhaw: 2250, name: 'JMD Patil' });
    assert.equal(await bhawService.feedStamp('jmd_patil'), '149557|-1200|2250');
  }
});

test('no MCX buy, or no rows at all: the raw diff as given (a feed that publishes only a bhaw)', async () => {
  // MCX buy '-': the spread cannot be taken off.
  useBoard([{
    source: 'jmd_patil',
    name: 'JMD Patil',
    cash_bhaw: '-1173',
    rtgs_bhaw: '2277',
    rows: [{ label: 'Gold Future MCX', buy: '-', sell: '149557' }],
  }]);
  assert.deepEqual(await bhawService.getBhawForSource('jmd_patil'), { cashBhaw: -1173, rtgsBhaw: 2277, name: 'JMD Patil' });

  // A side sell but no MCX line to take it from: the diff, added to the
  // market MCX as before.
  useBoard([{
    source: 'jmd_patil',
    name: 'JMD Patil',
    cash_bhaw: '-1173',
    rtgs_bhaw: null,
    rows: [{ label: 'Gold Future MCX', buy: '149530', sell: '-' }, { label: '99.50 Gold Cash', sell: '148357' }],
  }]);
  assert.deepEqual(await bhawService.getBhawForSource('jmd_patil'), { cashBhaw: -1173, rtgsBhaw: null, name: 'JMD Patil' });
  const r = await getLiveGoldRates(BIZ);
  assert.equal(r.taxSettings.pricingMcxLiveRate, MARKET_MCX);
  assert.equal(r.taxSettings.cashFinalRate, MARKET_MCX - 1173);

  // The legacy shape: only a bhaw, no rows.
  useBoard([{ source: 'jmd_patil', name: 'JMD Patil', cash_bhaw: '-3200', rtgs_bhaw: '4,800' }]);
  assert.deepEqual(await bhawService.getBhawForSource('jmd_patil'), { cashBhaw: -3200, rtgsBhaw: 4800, name: 'JMD Patil' });
  assert.equal(await bhawService.feedStamp('jmd_patil'), 'null|-3200|4800');
});

test('a side with no sell and no diff is not live: null, never 0', async () => {
  useBoard([house({ source: 'shri_sai', mcxBuy: 149530, mcxSell: 149557, rtgsSell: 151907 })]);
  assert.deepEqual(await bhawService.getBhawForSource('shri_sai'), { cashBhaw: null, rtgsBhaw: 2350, name: 'shri_sai' });

  // Neither side: the house is not live, and the stored fallback prices it.
  useBoard([{
    source: 'mega_bullion',
    name: 'Mega Bullion',
    cash_bhaw: null,
    rtgs_bhaw: '',
    rows: [
      { label: 'Gold Future MCX', buy: '149530', sell: '149557' },
      { label: '99.50 Gold Cash', buy: null, sell: null },
      { label: '99.50 Gold RTGS', buy: '-', sell: '-' },
    ],
  }], 'mega_bullion');
  assert.equal(await bhawService.getBhawForSource('mega_bullion'), null);
  assert.equal(await bhawService.feedStamp('mega_bullion'), 'off');
  const r = await getLiveGoldRates(BIZ);
  assert.equal(r.bhawSource.live, false);
  assert.equal(r.taxSettings.rtgsRate1FinalRate, 149557 + STORED.rtgsChange);
  assert.equal(r.taxSettings.cashFinalRate, 149557 + STORED.cashChange);
});

test('feedStamp moves with the premium or the line, and holds when only the MCX buy moves', async () => {
  const at = (fields) => [house({ mcxBuy: 149530, mcxSell: 149557, cashSell: 148357, rtgsSell: 151807, ...fields })];

  useBoard(at({}));
  const before = await bhawService.feedStamp('jmd_patil');
  assert.equal(before, '149557|-1200|2250');

  // The MCX buy ticks; the house's sells do not: the tracker's diffs move
  // by one, what the house charges does not, and neither does the stamp.
  useBoard(at({ mcxBuy: 149531 }));
  assert.equal(await bhawService.feedStamp('jmd_patil'), before);

  // The house moves its Cash premium: a new stamp.
  useBoard(at({ cashSell: 148407 }));
  assert.equal(await bhawService.feedStamp('jmd_patil'), '149557|-1150|2250');

  // The whole board moves with MCX: same premiums, new line, new stamp.
  useBoard(at({ mcxBuy: 149630, mcxSell: 149657, cashSell: 148457, rtgsSell: 151907 }));
  assert.equal(await bhawService.feedStamp('jmd_patil'), '149657|-1200|2250');
});

test('a cached rate stands while the premium holds, and is worked out again once it moves', async () => {
  useBoard([house({ mcxBuy: 149530, mcxSell: 149557, cashSell: 148357, rtgsSell: 151807 })]);
  const first = await getLiveGoldRates(BIZ);
  assert.equal(first.feedStamp, await bhawService.feedStamp('jmd_patil'), 'stored with the stamp it is checked against');
  assert.equal(first.build, RUNNING_COMMIT);

  // Only the MCX buy moves: served from the cache, still the house's sells.
  useBoard([house({ mcxBuy: 149540, mcxSell: 149557, cashSell: 148357, rtgsSell: 151807 })]);
  state.cached = first;
  const served = await getLiveGoldRates(BIZ);
  assert.equal(served, first, 'served as cached');
  assert.equal(state.writes.length, 0);

  // The RTGS sell moves by 10: worked out again, at the new sell.
  useBoard([house({ mcxBuy: 149540, mcxSell: 149557, cashSell: 148357, rtgsSell: 151817 })]);
  state.cached = first;
  const moved = await getLiveGoldRates(BIZ);
  assert.notEqual(moved, first);
  assert.equal(moved.taxSettings.rtgsRate1FinalRate, 151817);
  assert.equal(moved.feedStamp, '149557|-1200|2260');
  assert.equal(state.writes.length, 1);
});

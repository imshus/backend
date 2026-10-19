/**
 * Every house on the 3-minute feed can be followed, end to end.
 *
 * The feed grew from four houses to eleven (19 Oct 2026). POST
 * /settings/bullion used to refuse any house but the four it had by name, so
 * a shop could not pick SMD Bullion or KP Bullion at all; and the rate
 * calculation read the same four, so a house it did not know was priced on
 * the older boolean's house (Mega Bullion) instead.
 *
 * Pins: the list is the feed's (keys and names, in order); any house on it is
 * accepted, anything else refused; the house followed survives a feed that
 * is down; a requested name that is now on the feed is that house; and a
 * house with one bhaw side, or none, is priced exactly as Shri Sai (RTGS
 * only) and Mega Bullion (none) already were — the house's own MCX line plus
 * its own premium where it has published that side, the stored supreme
 * change where it has not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'src');
const CONTROLLER = path.join(SRC, 'controllers', 'settings.controller.js');
const RATES = path.join(SRC, 'services', 'rateCalculation.service.js');

/** The scheduler's stored MCX: what a house with no line of its own stands on. */
const MARKET_MCX = 148400;
/** The stored supreme changes: the fallback for a side a house has not published. */
const STORED = { rtgsChange: 111, cashChange: -111 };

const stub = (from, request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: from, filename: from, paths: Module._nodeModulePaths(path.dirname(from)),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

/** A settings collection in memory: findOne / findOneAndUpdate as userScope uses them. */
function fakeSettings() {
  const table = { rows: [] };
  const matches = (row, filter) => Object.entries(filter)
    .every(([key, value]) => String(row[key] ?? '') === String(value ?? ''));
  table.findOne = async (filter) => table.rows.find((row) => matches(row, filter)) || null;
  table.findOneAndUpdate = async (filter, update) => {
    let row = table.rows.find((entry) => matches(entry, filter));
    if (!row) {
      row = { businessId: filter.businessId, userId: filter.userId ?? null };
      table.rows.push(row);
    }
    Object.assign(row, update.$set);
    return row;
  };
  table.syncIndexes = async () => {};
  return table;
}

const BullionSource = fakeSettings();
const DashboardMetrics = fakeSettings();

const state = {
  feed: null,
  feedDown: false,
  invalidated: [],
};

// The 3-minute feed: a non-stream body is taken as the snapshot itself.
stub(RATES, 'axios', {
  get: async () => {
    if (state.feedDown) throw new Error('connect ECONNREFUSED');
    return { data: state.feed };
  },
});
stub(CONTROLLER, '../models/bullionSource.model', BullionSource);
stub(CONTROLLER, '../models/dashboardMetrics.model', DashboardMetrics);
stub(CONTROLLER, '../services/redis.service', {
  invalidateGoldRatesCache: async (businessId) => { state.invalidated.push(businessId); },
  getGoldRatesCache: async () => null,
  setGoldRatesCache: async () => {},
  getSupremeCache: async () => null,
  getGoldRatesGeneration: async () => 0,
  bumpGoldRatesGeneration: async () => {},
});
stub(RATES, './mcx.service', { getLiveMcxRate24K: async () => MARKET_MCX });
stub(RATES, '../models/goldTaxSetting.model', {
  // No change of the shop's own: the figures are the house's, as quoted.
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
stub(RATES, '../models/goldRate.model', GoldRateStub);
stub(RATES, '../models/supremeChange.model', { findOne: () => ({ sort: async () => STORED }) });

const bhawService = require(path.join(SRC, 'services', 'bhaw.service.js'));
const { getBullionSources, updateBullionSources } = require(CONTROLLER);
const { getLiveGoldRates } = require(RATES);

/**
 * One house as the tracker publishes it: its three rows and the diffs (side
 * sell less MCX buy). A side with no sell is null on both, as on the feed.
 */
const house = (source, name, { mcxSell, cashSell = null, rtgsSell = null }) => {
  const mcxBuy = mcxSell - 16;
  return {
    source,
    name,
    rows: [
      { label: 'Gold Future MCX', buy: String(mcxBuy), sell: String(mcxSell) },
      { label: '99.50 Gold Cash', buy: cashSell === null ? null : String(cashSell - 1000), sell: cashSell === null ? null : String(cashSell) },
      { label: '99.50 Gold RTGS', buy: rtgsSell === null ? null : String(rtgsSell - 1600), sell: rtgsSell === null ? null : String(rtgsSell) },
    ],
    cash_bhaw: cashSell === null ? null : cashSell - mcxBuy,
    rtgs_bhaw: rtgsSell === null ? null : rtgsSell - mcxBuy,
  };
};

/** The eleven houses as the feed carried them on 19 Oct 2026, 11:14 IST. */
const LINE = 148452;
const ELEVEN = [
  house('jmd_patil', 'JMD Patil', { mcxSell: LINE, cashSell: 148352, rtgsSell: 150652 }),
  house('mega_bullion', 'Mega Bullion', { mcxSell: LINE }),
  house('shri_sai', 'Shri Sai Jewels', { mcxSell: LINE, rtgsSell: 150752 }),
  house('shri_ganesh', 'Shri Ganesh Bullion', { mcxSell: LINE }),
  house('smd_bullion', 'SMD Bullion', { mcxSell: LINE, rtgsSell: 150382 }),
  house('shree_ram', 'Shree Ram Jewellers', { mcxSell: LINE, rtgsSell: 150588 }),
  house('kp_bullion', 'KP Bullion', { mcxSell: 148453, rtgsSell: 146953 }),
  house('vijaylaxmi_bullion', 'Vijaylaxmi Bullion', { mcxSell: LINE, rtgsSell: 150331 }),
  house('kj_bullion', 'KJ Bullion', { mcxSell: LINE }),
  house('sms_bullion', 'SMS Bullion', { mcxSell: LINE }),
  house('sln_bullion', 'SLN Bullion', { mcxSell: LINE }),
];
const KEYS = ELEVEN.map((entry) => entry.source);

const BIZ = '507f1f77bcf86cd799439011';
const OWNER = { businessId: BIZ, userId: 'owner-1', role: 'OWNER' };
const EMPLOYEE = { businessId: BIZ, userId: 'emp-7', role: 'EMP' };

/** A fresh shop on a fresh board: nothing saved, the feed as given. */
const reset = ({ feed = { fetched_at: '2026-10-19T11:14:43+0530', sources: ELEVEN }, feedDown = false } = {}) => {
  BullionSource.rows.length = 0;
  DashboardMetrics.rows.length = 0;
  state.feed = feed;
  state.feedDown = feedDown;
  state.invalidated = [];
  bhawService.__internal.resetCache();
};

const makeRes = () => ({
  statusCode: null,
  payload: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.payload = body; return this; },
});

const get = async (user = OWNER) => {
  const res = makeRes();
  await getBullionSources({ user }, res);
  return res;
};

const post = async (body, user = OWNER) => {
  const res = makeRes();
  await updateBullionSources({ user, body }, res);
  return res;
};

const ownerRecord = () => BullionSource.rows.find((row) => row.userId === null);
const ownerMetrics = () => DashboardMetrics.rows.find((row) => row.userId === null);

// ---- the list ------------------------------------------------------------

test('GET lists every house on the feed, by its key and the feed\'s own name, in the feed\'s order', async () => {
  reset();
  const res = await get();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.data.builtIn, ELEVEN.map((entry) => ({ key: entry.source, label: entry.name })));
  // Nothing chosen: the older boolean's house, JMD Patil when unset.
  assert.equal(res.payload.data.selected, 'jmd_patil');
  assert.deepEqual(res.payload.data.requestedNames, []);
});

test('a house the feed adds tomorrow is on the list with no change here', async () => {
  reset({ feed: { sources: [...ELEVEN, house('new_house', 'New House Bullion', { mcxSell: LINE, rtgsSell: 150500 })] } });
  const res = await get();
  assert.equal(res.payload.data.builtIn.at(-1).key, 'new_house');
  assert.equal(res.payload.data.builtIn.at(-1).label, 'New House Bullion');
  assert.equal((await post({ selected: 'new_house', requestedNames: [] })).statusCode, 200);
  assert.equal(ownerRecord().selected, 'new_house');
});

// ---- choosing --------------------------------------------------------------

test('POST accepts every one of the eleven houses, and GET then reads it back', async () => {
  for (const key of KEYS) {
    reset();
    const res = await post({ selected: key, requestedNames: [] });
    assert.equal(res.statusCode, 200, `${key} accepted`);
    assert.equal(res.payload.data.selected, key);
    assert.equal(ownerRecord().selected, key);
    // The older boolean kept in step, and the cached rate dropped.
    assert.equal(ownerMetrics().metricsData.bhaw_source_jmd, key === 'jmd_patil');
    assert.deepEqual(state.invalidated, [BIZ]);
    assert.equal((await get()).payload.data.selected, key, `${key} read back`);
  }
});

test('POST refuses a house that is not on the feed, and saves nothing', async () => {
  reset();
  await post({ selected: 'smd_bullion', requestedNames: [] });
  state.invalidated = [];
  for (const selected of ['gupta_bullion', 'Gupta Jewellers', 'x'.repeat(500), ['smd_bullion'], { key: 'smd_bullion' }]) {
    const res = await post({ selected, requestedNames: [] });
    assert.equal(res.statusCode, 400, `${JSON.stringify(selected).slice(0, 30)} refused`);
    assert.equal(res.payload.message, 'Pick one of the bullion houses on the feed');
  }
  assert.equal(ownerRecord().selected, 'smd_bullion', 'the house followed stands');
  assert.deepEqual(state.invalidated, []);
});

test('POST trims what it is sent, and takes a house by its feed name too', async () => {
  reset();
  assert.equal((await post({ selected: '  kp_bullion  ', requestedNames: [] })).payload.data.selected, 'kp_bullion');
  assert.equal((await post({ selected: ' smd   BULLION ', requestedNames: [] })).payload.data.selected, 'smd_bullion');
  assert.equal(ownerRecord().selected, 'smd_bullion', 'stored by its key');
});

test('POST with no house sent keeps the one followed (it used to switch the shop to the second house)', async () => {
  reset();
  await post({ selected: 'vijaylaxmi_bullion', requestedNames: [] });
  const res = await post({ requestedNames: ['Gupta Jewellers'] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.selected, 'vijaylaxmi_bullion');
  assert.deepEqual(res.payload.data.requestedNames, ['Gupta Jewellers']);
});

test('an employee\'s choice is their own; the shop\'s stands', async () => {
  reset();
  await post({ selected: 'shree_ram', requestedNames: [] }, OWNER);
  // The employee inherits the shop's house until they choose.
  assert.equal((await get(EMPLOYEE)).payload.data.selected, 'shree_ram');
  await post({ selected: 'sln_bullion', requestedNames: [] }, EMPLOYEE);
  assert.equal((await get(EMPLOYEE)).payload.data.selected, 'sln_bullion');
  assert.equal((await get(OWNER)).payload.data.selected, 'shree_ram');
});

// ---- the feed down ---------------------------------------------------------

test('feed down: the known houses are the list, and the house followed is kept and can be saved again', async () => {
  reset();
  await post({ selected: 'smd_bullion', requestedNames: [] });

  reset({ feedDown: true });
  BullionSource.rows.push({ businessId: BIZ, userId: null, selected: 'smd_bullion', customNames: [] });
  DashboardMetrics.rows.push({ businessId: BIZ, userId: null, metricsData: { bhaw_source_jmd: false } });

  const res = await get();
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.selected, 'smd_bullion', 'not moved to Mega Bullion by the boolean');
  assert.deepEqual(res.payload.data.builtIn.map((entry) => entry.key), KEYS, 'the known eleven');
  assert.equal(res.payload.data.builtIn.find((entry) => entry.key === 'smd_bullion').label, 'SMD Bullion');

  // Adding a name re-sends the house followed: never refused for the feed being down.
  const saved = await post({ selected: 'smd_bullion', requestedNames: ['Gupta Jewellers'] });
  assert.equal(saved.statusCode, 200);
  assert.equal(ownerRecord().selected, 'smd_bullion');
  assert.deepEqual(ownerRecord().customNames, ['Gupta Jewellers']);
});

test('feed down: a house the known list has not heard of is kept for the shop that follows it, and refused to others', async () => {
  reset({ feedDown: true });
  BullionSource.rows.push({ businessId: BIZ, userId: null, selected: 'new_house', customNames: [] });
  DashboardMetrics.rows.push({ businessId: BIZ, userId: null, metricsData: { bhaw_source_jmd: false } });

  const res = await get();
  assert.equal(res.payload.data.selected, 'new_house');
  assert.ok(res.payload.data.builtIn.some((entry) => entry.key === 'new_house'), 'listed, so the app can name it');
  assert.equal((await post({ selected: 'new_house', requestedNames: [] })).statusCode, 200);
  assert.equal((await post({ selected: 'other_house', requestedNames: [] })).statusCode, 400);
  // A known house can still be picked while the feed is down.
  assert.equal((await post({ selected: 'kj_bullion', requestedNames: [] })).statusCode, 200);
});

test('a house marked down on this round\'s snapshot is still on the list', async () => {
  reset({ feed: { sources: ELEVEN.map((entry) => (entry.source === 'kp_bullion' ? { ...entry, ok: false } : entry)) } });
  const res = await get();
  assert.ok(res.payload.data.builtIn.some((entry) => entry.key === 'kp_bullion'));
  assert.equal((await post({ selected: 'kp_bullion', requestedNames: [] })).statusCode, 200);
});

// ---- requested names ---------------------------------------------------------

test('a requested name that is now on the feed is that house, not a request still waiting', async () => {
  reset();
  // Asked for before these houses were on the feed.
  BullionSource.rows.push({
    businessId: BIZ,
    userId: null,
    selected: 'jmd_patil',
    customNames: ['smd bullion', 'Gupta Jewellers', 'KPBullion'],
  });
  const res = await get();
  assert.deepEqual(res.payload.data.requestedNames, ['Gupta Jewellers']);

  // Sent again: the stored list loses them too.
  const saved = await post({ selected: 'jmd_patil', requestedNames: ['SMD Bullion', 'Gupta Jewellers', 'Shree Ram  Jewellers'] });
  assert.deepEqual(saved.payload.data.requestedNames, ['Gupta Jewellers']);
  assert.deepEqual(ownerRecord().customNames, ['Gupta Jewellers']);
  assert.equal(ownerRecord().selected, 'jmd_patil', 'asking never moves the house followed');
});

test('a record holding a house\'s name (an older build) follows that house now it is on the feed', async () => {
  reset();
  BullionSource.rows.push({ businessId: BIZ, userId: null, selected: 'Shree Ram Jewellers', customNames: [] });
  DashboardMetrics.rows.push({ businessId: BIZ, userId: null, metricsData: { bhaw_source_jmd: false } });
  assert.equal((await get()).payload.data.selected, 'shree_ram');
  const rates = await getLiveGoldRates(BIZ);
  assert.equal(rates.bhawSource.key, 'shree_ram', 'priced on the house the screen ticks');

  // A name on no board stays the older boolean's house, on both sides.
  reset();
  BullionSource.rows.push({ businessId: BIZ, userId: null, selected: 'Gupta Jewellers', customNames: [] });
  DashboardMetrics.rows.push({ businessId: BIZ, userId: null, metricsData: { bhaw_source_jmd: false } });
  assert.equal((await get()).payload.data.selected, 'mega_bullion');
  assert.equal((await getLiveGoldRates(BIZ)).bhawSource.key, 'mega_bullion');
});

// ---- pricing -----------------------------------------------------------------

/** Chooses a house the way the phone does, then prices as a scan does. */
const priceOn = async (key) => {
  reset();
  assert.equal((await post({ selected: key, requestedNames: [] })).statusCode, 200);
  return getLiveGoldRates(BIZ);
};

test('a house chosen on the phone is the house a scan is priced on, for all eleven', async () => {
  for (const entry of ELEVEN) {
    const rates = await priceOn(entry.source);
    assert.equal(rates.bhawSource.key, entry.source);
    // Named by the feed, live bhaw or not — never by its key.
    assert.equal(rates.bhawSource.name, entry.name);
  }
});

test('RTGS only (SMD Bullion): priced exactly as Shri Sai is — its own RTGS sell, the stored change for Cash', async () => {
  const smd = await priceOn('smd_bullion');
  assert.equal(smd.bhawSource.live, true);
  assert.equal(smd.taxSettings.mcxFinalRate, LINE, 'the MCX is the house\'s own line');
  assert.equal(smd.supremeChanges.rtgsChange, 150382 - LINE, 'its premium over its own MCX sell');
  assert.equal(smd.taxSettings.rtgsRate1FinalRate, 150382, 'RTGS is SMD\'s own RTGS sell');
  assert.equal(smd.taxSettings.rtgsFinalRate, 150382, 'the RTGS a scan charges');
  assert.equal(smd.supremeChanges.cashChange, STORED.cashChange, 'no Cash on its board: the stored change');
  assert.equal(smd.taxSettings.cashFinalRate, LINE + STORED.cashChange);
  assert.equal(smd.feedStamp, `${LINE}|null|${150382 - LINE}`);

  const sai = await priceOn('shri_sai');
  assert.equal(sai.taxSettings.rtgsRate1FinalRate, 150752);
  assert.equal(sai.taxSettings.cashFinalRate, LINE + STORED.cashChange, 'the same fallback, the same arithmetic');

  // KP Bullion quotes a discount, on its own line.
  const kp = await priceOn('kp_bullion');
  assert.equal(kp.taxSettings.mcxFinalRate, 148453);
  assert.equal(kp.taxSettings.rtgsRate1FinalRate, 146953);
  assert.equal(kp.taxSettings.cashFinalRate, 148453 + STORED.cashChange);
});

test('no bhaw at all (KJ Bullion): priced exactly as Mega Bullion is — its own MCX line plus the stored changes', async () => {
  const mega = await priceOn('mega_bullion');
  const kj = await priceOn('kj_bullion');
  for (const [label, rates] of [['mega_bullion', mega], ['kj_bullion', kj]]) {
    assert.equal(rates.bhawSource.live, false, label);
    assert.equal(rates.feedStamp, 'off', label);
    assert.equal(rates.taxSettings.mcxFinalRate, LINE, `${label}: its own line, not the market's ${MARKET_MCX}`);
    assert.equal(rates.taxSettings.pricingMcxLiveRate, LINE, label);
    assert.equal(rates.supremeChanges.rtgsChange, STORED.rtgsChange, label);
    assert.equal(rates.supremeChanges.cashChange, STORED.cashChange, label);
    assert.equal(rates.taxSettings.rtgsRate1FinalRate, LINE + STORED.rtgsChange, label);
    assert.equal(rates.taxSettings.cashFinalRate, LINE + STORED.cashChange, label);
  }
  assert.deepEqual(kj.taxSettings, mega.taxSettings, 'the same figures, to the rupee');
  assert.deepEqual(kj.karatRates, mega.karatRates);
  assert.equal(kj.bhawSource.name, 'KJ Bullion');
});

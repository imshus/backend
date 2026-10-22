/**
 * JMD Patil is the house a shop follows until it chooses another, everywhere:
 * Choose a Bullion (GET /settings/bullion), the older boolean the app still
 * reads (GET /settings/matrices), and the rate a scan is priced on.
 *
 * Shops that never chose were landing on Mega Bullion by these paths:
 *
 *   - the older boolean saved false: from 29 Aug to 21 Sep 2026 its default
 *     was false (server and app alike), and every save of the Home tiles
 *     wrote the default along with them. A false with no Choose a Bullion
 *     record behind it is that default far more often than a choice — and
 *     the old radio could not even write Mega by a tap while Mega was the
 *     default — so it is no longer read as one;
 *   - a Choose a Bullion record that names no house (blank, or a name the
 *     shop typed in) fell back to that boolean;
 *   - a save that sent no house (adding a name) wrote the house the shop
 *     happened to be shown — Mega, by the boolean — as if it had been picked;
 *   - an employee's own record with no house in it hid the shop's choice and
 *     fell back to the boolean.
 *
 * A house the shop did choose — Mega Bullion included — is kept on every one
 * of those paths.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'src');
const CONTROLLER = path.join(SRC, 'controllers', 'settings.controller.js');
const RATES = path.join(SRC, 'services', 'rateCalculation.service.js');

const stub = (from, request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: from, filename: from, paths: Module._nodeModulePaths(path.dirname(from)),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

/** A settings collection in memory: findOne / findOneAndUpdate as userScope uses them. */
function fakeSettings(defaults = {}) {
  const table = { rows: [] };
  const matches = (row, filter) => Object.entries(filter)
    .every(([key, value]) => String(row[key] ?? '') === String(value ?? ''));
  table.findOne = async (filter) => table.rows.find((row) => matches(row, filter)) || null;
  table.findOneAndUpdate = async (filter, update) => {
    let row = table.rows.find((entry) => matches(entry, filter));
    if (!row) {
      // setDefaultsOnInsert, as mongoose does on an upsert.
      row = { businessId: filter.businessId, userId: filter.userId ?? null, ...defaults };
      table.rows.push(row);
    }
    Object.assign(row, update.$set);
    return row;
  };
  table.syncIndexes = async () => {};
  return table;
}

const BullionSource = fakeSettings({ selected: '', customNames: [] });
const DashboardMetrics = fakeSettings({ metricsData: {} });

const LINE = 148452;
const board = (source, name, rtgsSell = null) => ({
  source,
  name,
  rows: [
    { label: 'Gold Future MCX', buy: String(LINE - 16), sell: String(LINE) },
    { label: '99.50 Gold RTGS', buy: null, sell: rtgsSell === null ? null : String(rtgsSell) },
  ],
  cash_bhaw: null,
  rtgs_bhaw: rtgsSell === null ? null : rtgsSell - (LINE - 16),
});
const FEED = [
  board('jmd_patil', 'JMD Patil', 150652),
  board('mega_bullion', 'Mega Bullion'),
  board('smd_bullion', 'SMD Bullion', 150382),
];

stub(RATES, 'axios', { get: async () => ({ data: { sources: FEED } }) });
stub(CONTROLLER, '../models/bullionSource.model', BullionSource);
stub(CONTROLLER, '../models/dashboardMetrics.model', DashboardMetrics);
stub(CONTROLLER, '../services/redis.service', {
  invalidateGoldRatesCache: async () => {},
  getGoldRatesCache: async () => null,
  setGoldRatesCache: async () => {},
  getSupremeCache: async () => null,
  getGoldRatesGeneration: async () => 0,
  bumpGoldRatesGeneration: async () => {},
});
stub(RATES, './mcx.service', { getLiveMcxRate24K: async () => 148400 });
stub(RATES, '../models/goldTaxSetting.model', { findOne: async () => null });
function GoldRateStub(doc) { Object.assign(this, doc); }
GoldRateStub.prototype.save = async function save() { return this; };
GoldRateStub.find = async () => [{ carat: '22Kt', purity: 91.6 }];
stub(RATES, '../models/goldRate.model', GoldRateStub);
stub(RATES, '../models/supremeChange.model', { findOne: () => ({ sort: async () => ({ rtgsChange: 111, cashChange: -111 }) }) });

const bhawService = require(path.join(SRC, 'services', 'bhaw.service.js'));
const {
  getBullionSources,
  updateBullionSources,
  getDashboardMatrices,
  updateDashboardMatrices,
} = require(CONTROLLER);
const { getLiveGoldRates } = require(RATES);

const BIZ = '507f1f77bcf86cd799439011';
const EMP_ID = '64b7f0c2a1b2c3d4e5f60718';
const OWNER = { businessId: BIZ, userId: 'owner-1', role: 'OWNER' };
const EMPLOYEE = { businessId: BIZ, userId: EMP_ID, role: 'EMP' };

const reset = () => {
  BullionSource.rows.length = 0;
  DashboardMetrics.rows.length = 0;
  bhawService.__internal.resetCache();
};

const shopChose = (selected, customNames = []) => {
  BullionSource.rows.push({ businessId: BIZ, userId: null, selected, customNames });
};
const shopBoolean = (value) => {
  DashboardMetrics.rows.push({ businessId: BIZ, userId: null, metricsData: { '24k_mcx': true, bhaw_source_jmd: value } });
};

const call = async (handler, user, body) => {
  const res = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await handler({ user, body }, res);
  return res;
};

/** The house every reader names for `user`: Choose a Bullion, the boolean, and pricing. */
const houseEverywhere = async (user = OWNER) => {
  const bullion = await call(getBullionSources, user);
  const matrices = await call(getDashboardMatrices, user);
  const rates = await getLiveGoldRates(BIZ, user.role === 'EMP' ? { userId: user.userId } : null);
  return {
    screen: bullion.payload.data.selected,
    boolean: matrices.payload.data.bhaw_source_jmd,
    priced: rates.bhawSource.key,
  };
};

const JMD_EVERYWHERE = { screen: 'jmd_patil', boolean: true, priced: 'jmd_patil' };
const MEGA_EVERYWHERE = { screen: 'mega_bullion', boolean: false, priced: 'mega_bullion' };

// ---- never chosen: JMD Patil ------------------------------------------------

test('a new shop with nothing saved follows JMD Patil', async () => {
  reset();
  assert.deepEqual(await houseEverywhere(), JMD_EVERYWHERE);
});

test('the older boolean saved false with no Choose a Bullion record (a 29 Aug-21 Sep default) is JMD Patil', async () => {
  reset();
  shopBoolean(false);
  assert.deepEqual(await houseEverywhere(), JMD_EVERYWHERE);
});

test('a Choose a Bullion record that names no house is JMD Patil, whatever the boolean says', async () => {
  for (const selected of ['', '   ', null, undefined, 'Gupta Jewellers', 'gupta']) {
    reset();
    shopChose(selected, ['Gupta Jewellers', 'gupta']);
    shopBoolean(false);
    assert.deepEqual(await houseEverywhere(), JMD_EVERYWHERE, JSON.stringify(selected));
  }
});

test('a save of the Home tiles that carries the boolean false (an older build, or its default) moves nobody to Mega Bullion', async () => {
  reset();
  const saved = await call(updateDashboardMatrices, OWNER, { values: { '24k_mcx': true, '22k_rtgs': true, bhaw_source_jmd: false } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.payload.data['22k_rtgs'], true, 'the tile is saved');
  assert.equal(saved.payload.data.bhaw_source_jmd, true, 'the boolean answers for the house followed');
  assert.deepEqual(await houseEverywhere(), JMD_EVERYWHERE);
});

test('adding a name before any house is chosen records the name, not a house', async () => {
  reset();
  shopBoolean(false);
  const res = await call(updateBullionSources, OWNER, { requestedNames: ['Gupta Jewellers'] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.selected, 'jmd_patil');
  assert.deepEqual(res.payload.data.requestedNames, ['Gupta Jewellers']);
  const record = BullionSource.rows.find((row) => row.userId === null);
  assert.equal(record.selected, '', 'it used to store Mega Bullion here, as if picked');
  assert.deepEqual(await houseEverywhere(), JMD_EVERYWHERE);
});

test('an employee with a boolean of their own and no house chosen anywhere follows JMD Patil', async () => {
  reset();
  DashboardMetrics.rows.push({ businessId: BIZ, userId: EMP_ID, metricsData: { bhaw_source_jmd: false } });
  assert.deepEqual(await houseEverywhere(EMPLOYEE), JMD_EVERYWHERE);
});

// ---- chosen: kept -----------------------------------------------------------

test('Mega Bullion chosen on Choose a Bullion is kept, whatever the boolean says', async () => {
  for (const value of [true, false, undefined]) {
    reset();
    shopChose('mega_bullion');
    if (value !== undefined) shopBoolean(value);
    assert.deepEqual(await houseEverywhere(), MEGA_EVERYWHERE, String(value));
  }
});

test('choosing Mega Bullion is saved and read back everywhere; choosing JMD Patil again is too', async () => {
  reset();
  const res = await call(updateBullionSources, OWNER, { selected: 'mega_bullion' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.selected, 'mega_bullion');
  assert.deepEqual(await houseEverywhere(), MEGA_EVERYWHERE);
  // A tile saved since, by a build that still sends the boolean, does not undo it.
  await call(updateDashboardMatrices, OWNER, { values: { '24k_mcx': true, bhaw_source_jmd: true } });
  assert.deepEqual(await houseEverywhere(), MEGA_EVERYWHERE);

  await call(updateBullionSources, OWNER, { selected: 'jmd_patil' });
  assert.deepEqual(await houseEverywhere(), JMD_EVERYWHERE);
});

test('adding a name keeps the house chosen', async () => {
  reset();
  shopChose('mega_bullion');
  const res = await call(updateBullionSources, OWNER, { requestedNames: ['Gupta Jewellers'] });
  assert.equal(res.payload.data.selected, 'mega_bullion');
  assert.equal(BullionSource.rows.find((row) => row.userId === null).selected, 'mega_bullion');
  assert.deepEqual(await houseEverywhere(), MEGA_EVERYWHERE);
});

test('an employee follows the shop\'s chosen house until they choose their own', async () => {
  reset();
  shopChose('mega_bullion');
  // Their own boolean (a default their tiles saved) does not stand in for the shop's choice.
  DashboardMetrics.rows.push({ businessId: BIZ, userId: EMP_ID, metricsData: { bhaw_source_jmd: true } });
  assert.deepEqual(await houseEverywhere(EMPLOYEE), MEGA_EVERYWHERE);

  // A name they added gives them a record of their own, with no house in it.
  const added = await call(updateBullionSources, EMPLOYEE, { requestedNames: ['Gupta Jewellers'] });
  assert.equal(added.payload.data.selected, 'mega_bullion');
  assert.deepEqual(await houseEverywhere(EMPLOYEE), MEGA_EVERYWHERE, 'still the shop\'s house');

  await call(updateBullionSources, EMPLOYEE, { selected: 'smd_bullion' });
  const own = await houseEverywhere(EMPLOYEE);
  assert.equal(own.screen, 'smd_bullion');
  assert.equal(own.priced, 'smd_bullion');
  assert.deepEqual(await houseEverywhere(OWNER), MEGA_EVERYWHERE, 'the shop\'s stands');
});

test('an employee\'s own record with no house in it does not hide the shop\'s choice', async () => {
  reset();
  shopChose('smd_bullion');
  BullionSource.rows.push({ businessId: BIZ, userId: EMP_ID, selected: '', customNames: ['Gupta Jewellers'] });
  DashboardMetrics.rows.push({ businessId: BIZ, userId: EMP_ID, metricsData: { bhaw_source_jmd: false } });
  const seen = await houseEverywhere(EMPLOYEE);
  assert.equal(seen.screen, 'smd_bullion');
  assert.equal(seen.priced, 'smd_bullion');
  assert.equal(seen.boolean, false);
  // Their own requested names are theirs.
  assert.deepEqual((await call(getBullionSources, EMPLOYEE)).payload.data.requestedNames, ['Gupta Jewellers']);
});

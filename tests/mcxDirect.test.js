/**
 * Pricing takes the MCX straight off the 3-minute board this process holds,
 * and keeps the rates it works out in its own memory:
 *  - the MCX is the board's majority figure: no Redis call, and no network
 *    while the board is fresh; the stored MCX only when no board is in hand,
 *    and no rate at all (never a made-up one) when there is neither;
 *  - the supreme rates screen shows that same board MCX;
 *  - the worked-out rates are served from memory per business and per
 *    employee while the board reads the same (feedStamp) and no settings
 *    save or board move has cleared them (the generation): a cache hit costs
 *    no Redis, no database and no network;
 *  - a compute a settings save overtakes is not cached.
 * The Redis client, the database and the board's feed are stood in for.
 */
process.env.USE_MEMORY_STORE = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const axios = require('axios');

const redisCalls = [];
const redisData = new Map();
const fakeRedis = {
  get: async (key) => {
    redisCalls.push(`get ${key}`);
    return redisData.has(key) ? redisData.get(key) : null;
  },
  set: async (key, value) => {
    redisCalls.push(`set ${key}`);
    redisData.set(key, String(value));
    return 'OK';
  },
  del: async (...keys) => {
    redisCalls.push(`del ${keys.join(',')}`);
    return keys.filter((key) => redisData.delete(key)).length;
  },
  incr: async (key) => {
    redisCalls.push(`incr ${key}`);
    return 1;
  },
  keys: async () => {
    redisCalls.push('keys');
    return [];
  },
};
const clientPath = require.resolve(path.join(__dirname, '..', 'src', 'redis', 'redisClient.js'));
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: fakeRedis };

const bhawService = require('../src/services/bhaw.service');
const mcxService = require('../src/services/mcx.service');
const redisService = require('../src/services/redis.service');
const rateCalculation = require('../src/services/rateCalculation.service');
const GoldTaxSetting = require('../src/models/goldTaxSetting.model');
const GoldRate = require('../src/models/goldRate.model');
const SupremeChange = require('../src/models/supremeChange.model');
const DashboardMetrics = require('../src/models/dashboardMetrics.model');
const BullionSource = require('../src/models/bullionSource.model');

const MAJORITY = 150720;
const STORED_MCX = 140000;

const board = (jmdLine, { fetchedAt = new Date().toISOString() } = {}) => ({
  fetched_at: fetchedAt,
  next_fetch_at: new Date(Date.now() + 180_000).toISOString(),
  sources: [
    { source: 'jmd_patil', name: 'JMD Patil', cash_bhaw: null, rtgs_bhaw: null,
      rows: [
        { label: 'Gold Future MCX', buy: String(jmdLine - 27), sell: String(jmdLine) },
        { label: '99.50 Gold Cash', buy: null, sell: String(jmdLine - 3100) },
        { label: '99.50 Gold RTGS', buy: null, sell: String(jmdLine + 2100) },
      ] },
    ...['mega_bullion', 'shri_sai', 'shri_ganesh'].map((source) => ({
      source, name: source, cash_bhaw: null, rtgs_bhaw: null,
      rows: [{ label: 'Gold Future MCX', buy: String(MAJORITY - 20), sell: String(MAJORITY) }],
    })),
  ],
});

const feed = { payload: board(153273), reads: 0, fail: false };
const reads = { tax: 0, goldRows: 0, supreme: 0 };

const original = {
  axiosGet: axios.get,
  taxFindOne: GoldTaxSetting.findOne,
  goldFind: GoldRate.find,
  supremeFindOne: SupremeChange.findOne,
  metricsFindOne: DashboardMetrics.findOne,
  bullionFindOne: BullionSource.findOne,
};

const KARAT_ROWS = [
  { _id: '1', carat: '22Kt', purity: 91.6, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
  { _id: '2', carat: '20Kt', purity: 85, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
  { _id: '3', carat: '18Kt', purity: 75, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
  { _id: '4', carat: '14Kt', purity: 58.5, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
  { _id: '5', carat: '9Kt', purity: 39, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
];

test.before(() => {
  axios.get = async () => {
    feed.reads += 1;
    if (feed.fail) throw new Error('feed down');
    return { data: feed.payload };
  };
  GoldTaxSetting.findOne = async () => {
    reads.tax += 1;
    return { mcxChange: { operation: '+', amount: 0 }, rtgsChangeBy: 0, cashChangeBy: 0, scannerCalculationUse: 'rtgs' };
  };
  GoldRate.find = async () => {
    reads.goldRows += 1;
    return KARAT_ROWS;
  };
  SupremeChange.findOne = () => ({
    sort: async () => {
      reads.supreme += 1;
      return null;
    },
  });
  DashboardMetrics.findOne = async () => null;
  BullionSource.findOne = async () => null;
  redisData.set('mcx_gold_live_rate', JSON.stringify({ rate: STORED_MCX, source: 'board' }));
});

test.after(() => {
  axios.get = original.axiosGet;
  GoldTaxSetting.findOne = original.taxFindOne;
  GoldRate.find = original.goldFind;
  SupremeChange.findOne = original.supremeFindOne;
  DashboardMetrics.findOne = original.metricsFindOne;
  BullionSource.findOne = original.bullionFindOne;
  bhawService.__internal.resetCache();
});

const quietly = async (fn) => {
  const { warn, log, info } = console;
  console.warn = () => {};
  console.log = () => {};
  console.info = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = log;
    console.info = info;
  }
};

/** A new board snapshot, as the keep-warm stream would hand it over. */
const newBoard = async (jmdLine) => {
  feed.payload = board(jmdLine, { fetchedAt: new Date(Date.now() + 1000).toISOString() });
  bhawService.__internal.resetCache();
  await bhawService.prefetch();
};

test('the MCX is the board\'s majority, with no Redis call and no network while the board is fresh', async () => {
  bhawService.__internal.resetCache();
  feed.reads = 0;
  redisCalls.length = 0;
  assert.equal(await mcxService.getLiveMcxRate24K(), MAJORITY, 'the board, not the stored 1,40,000');
  assert.equal(feed.reads, 1, 'one read of the feed brought the board in');
  assert.equal(await mcxService.getLiveMcxRate24K(), MAJORITY);
  assert.equal(feed.reads, 1, 'and the fresh board is read from memory after that');
  assert.deepEqual(redisCalls, []);
});

test('no board in hand: the stored MCX, and with none stored no rate at all', async () => {
  bhawService.__internal.resetCache();
  feed.fail = true;
  try {
    redisCalls.length = 0;
    assert.equal(await quietly(() => mcxService.getLiveMcxRate24K()), STORED_MCX);
    assert.deepEqual(redisCalls, ['get mcx_gold_live_rate'], 'Redis only as the fallback');

    redisData.delete('mcx_gold_live_rate');
    assert.equal(await quietly(() => mcxService.getLiveMcxRate24K()), null, 'never a made-up rate');
  } finally {
    feed.fail = false;
    redisData.set('mcx_gold_live_rate', JSON.stringify({ rate: STORED_MCX, source: 'board' }));
    bhawService.__internal.resetCache();
  }
});

test('the supreme rates screen shows the board MCX', async () => {
  await newBoard(153273);
  const { getSupremeRates } = require('../src/controllers/settings.controller');
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await getSupremeRates({ user: { userId: 'admin' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.mcx, MAJORITY);
  assert.equal(res.body.data.supremeRtgs, MAJORITY);
});

test('rates are worked out once and then served from memory: no Redis, no database, no network', async () => {
  await newBoard(153273);
  await redisService.invalidateAllGoldRatesCache();
  await redisService.setSupremeCache({ rtgsChange: 0, cashChange: 0 });
  redisCalls.length = 0;
  reads.tax = 0;
  reads.goldRows = 0;
  reads.supreme = 0;
  const feedReadsBefore = feed.reads;

  const first = await quietly(() => rateCalculation.getLiveGoldRates('biz-1'));
  assert.equal(first.mcxLiveRate, MAJORITY);
  assert.equal(first.taxSettings.rtgsFinalRate, 153273 + 2100, 'the house line plus its own RTGS premium');
  assert.equal(reads.tax, 1);
  assert.equal(reads.supreme, 0, 'the supreme changes came from this process');
  assert.deepEqual(redisCalls, [], 'a fresh compute pays no Redis round trip either');

  const second = await rateCalculation.getLiveGoldRates('biz-1');
  assert.deepEqual(second, first);
  assert.equal(reads.tax, 1, 'served from memory');
  assert.equal(reads.goldRows, 1);
  assert.equal(feed.reads, feedReadsBefore, 'no network');
  assert.deepEqual(redisCalls, []);
});

test('a settings save, a board move, or a supreme change clears the memory; each person has their own', async () => {
  await newBoard(153273);
  await redisService.invalidateAllGoldRatesCache();
  reads.tax = 0;
  await quietly(() => rateCalculation.getLiveGoldRates('biz-2'));
  await quietly(() => rateCalculation.getLiveGoldRates('biz-2', { userId: 'emp-1' }));
  assert.equal(reads.tax, 2, 'the shop and the employee are worked out separately');
  await rateCalculation.getLiveGoldRates('biz-2');
  await rateCalculation.getLiveGoldRates('biz-2', { userId: 'emp-1' });
  assert.equal(reads.tax, 2);

  // A settings save for the shop clears the shop's entries, the employee's too.
  await redisService.invalidateGoldRatesCache('biz-2');
  await quietly(() => rateCalculation.getLiveGoldRates('biz-2'));
  await quietly(() => rateCalculation.getLiveGoldRates('biz-2', { userId: 'emp-1' }));
  assert.equal(reads.tax, 4);

  // The followed house's line moves on a new snapshot: a new rate at once.
  await newBoard(153500);
  const moved = await quietly(() => rateCalculation.getLiveGoldRates('biz-2'));
  assert.equal(reads.tax, 5);
  assert.equal(moved.taxSettings.rtgsFinalRate, 153500 + 2100);

  // An MCX move or a supreme change (both clear everything).
  await redisService.invalidateAllGoldRatesCache();
  await quietly(() => rateCalculation.getLiveGoldRates('biz-2'));
  assert.equal(reads.tax, 6);
});

test('a compute a settings save overtakes is not cached', async () => {
  await newBoard(153273);
  await redisService.invalidateAllGoldRatesCache();
  reads.tax = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  GoldTaxSetting.findOne = async () => {
    reads.tax += 1;
    await held;
    return { mcxChange: { operation: '+', amount: 0 }, rtgsChangeBy: 0, cashChangeBy: 0, scannerCalculationUse: 'rtgs' };
  };
  try {
    const inFlight = quietly(() => rateCalculation.getLiveGoldRates('biz-3'));
    await new Promise((resolve) => setImmediate(resolve));
    await redisService.invalidateGoldRatesCache('biz-3');
    release();
    await inFlight;
    assert.equal(await redisService.getGoldRatesCache('biz-3'), null, 'the older settings were not cached');
  } finally {
    GoldTaxSetting.findOne = async () => {
      reads.tax += 1;
      return { mcxChange: { operation: '+', amount: 0 }, rtgsChangeBy: 0, cashChangeBy: 0, scannerCalculationUse: 'rtgs' };
    };
  }
});

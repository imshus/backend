const test = require('node:test');
const assert = require('node:assert/strict');

const axios = require('axios');
const redisService = require('../src/services/redis.service');
const MCXFetch = require('../src/models/mcxFetch.model');
const SupremeChange = require('../src/models/supremeChange.model');
const bhawService = require('../src/services/bhaw.service');

const {
  initMcxScheduler,
  watchBoardSnapshots,
  __internal: {
    resetSnapshotState,
    isWithinTradingWindow,
    getIstParts,
    getNextScheduledExecutionUtc,
    getNextTradingStartUtc,
    createUtcDateFromIst,
    schedulerConfig,
  },
} = require('../src/services/mcxScheduler.service');

function utcFromIst(year, month, day, hour, minute, second) {
  const seconds = (hour * 3600) + (minute * 60) + second;
  return createUtcDateFromIst(year, month, day, seconds);
}

function asIstParts(date) {
  return getIstParts(date);
}

test('scheduler config uses requested defaults', () => {
  assert.equal(schedulerConfig.timezone, 'Asia/Kolkata');
  assert.equal(schedulerConfig.pollIntervalSeconds, 140);
});

test('weekend is never in trading window', () => {
  const saturday1030Ist = utcFromIst(2026, 8, 1, 10, 30, 0);
  const parts = asIstParts(saturday1030Ist);
  assert.equal(isWithinTradingWindow(parts), false);
});

test('before market open schedules same-day 09:00 IST on trading day', () => {
  const tuesday0200Ist = utcFromIst(2026, 8, 4, 2, 0, 0);
  const next = getNextScheduledExecutionUtc(tuesday0200Ist);
  const nextParts = asIstParts(next);

  assert.equal(nextParts.weekday, 'tuesday');
  assert.equal(nextParts.hour, 9);
  assert.equal(nextParts.minute, 0);
  assert.equal(nextParts.second, 0);
});

test('inside market window schedules next 140-second slot', () => {
  const tuesday090100Ist = utcFromIst(2026, 8, 4, 9, 1, 0);
  const next = getNextScheduledExecutionUtc(tuesday090100Ist);
  const nextParts = asIstParts(next);

  assert.equal(nextParts.weekday, 'tuesday');
  assert.equal(nextParts.hour, 9);
  assert.equal(nextParts.minute, 2);
  assert.equal(nextParts.second, 20);
});

test('no forced fetch after final valid slot (23:55:20 is skipped)', () => {
  // With 09:00 start and 140s cadence, the final valid Friday slot is 23:53:40.
  // Any time after that should schedule next run on Monday 09:00 IST.
  const friday235341Ist = utcFromIst(2026, 7, 31, 23, 53, 41);
  const next = getNextScheduledExecutionUtc(friday235341Ist);
  const nextParts = asIstParts(next);

  assert.equal(nextParts.weekday, 'monday');
  assert.equal(nextParts.hour, 9);
  assert.equal(nextParts.minute, 0);
  assert.equal(nextParts.second, 0);
});

test('weekend schedules next Monday 09:00 IST', () => {
  const saturday101500Ist = utcFromIst(2026, 8, 1, 10, 15, 0);
  const next = getNextTradingStartUtc(saturday101500Ist);
  const nextParts = asIstParts(next);

  assert.equal(nextParts.weekday, 'monday');
  assert.equal(nextParts.hour, 9);
  assert.equal(nextParts.minute, 0);
  assert.equal(nextParts.second, 0);
});

test('startup always performs exactly one immediate synchronization fetch', async () => {
  const originalAxiosGet = axios.get;
  const originalGetMcxCacheSnapshot = redisService.getMcxCacheSnapshot;
  const originalSetMcxCache = redisService.setMcxCache;
  const originalSetSupremeCache = redisService.setSupremeCache;
  const originalInvalidateAllGoldRatesCache = redisService.invalidateAllGoldRatesCache;
  const originalFindMcxFetch = MCXFetch.findOne;
  const originalFindSupreme = SupremeChange.findOne;
  const originalBoardMcxSell = bhawService.boardMcxSell;
  const originalHouseMcxLines = bhawService.houseMcxLines;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  let apiCallCount = 0;

  try {
    // The board is the only MCX source since metals.dev was removed: each
    // read of its MCX line is one synchronization.
    axios.get = async () => ({ data: [] });
    bhawService.boardMcxSell = async () => {
      apiCallCount += 1;
      return 145320;
    };
    bhawService.houseMcxLines = async () => ({});

    redisService.getMcxCacheSnapshot = async () => ({ rate: 145120 });
    redisService.setMcxCache = async () => {};
    redisService.setSupremeCache = async () => {};
    redisService.invalidateAllGoldRatesCache = async () => {};

    MCXFetch.findOne = async () => ({
      lastFetchedTime: new Date(),
      expectedNextFetchTime: new Date(),
      numberOfApiCall: 3,
      save: async () => {},
    });

    SupremeChange.findOne = () => ({
      sort: async () => null,
    });

    global.setTimeout = () => ({ mocked: true });
    global.clearTimeout = () => {};

    await initMcxScheduler();
    assert.equal(apiCallCount, 1);
  } finally {
    axios.get = originalAxiosGet;
    redisService.getMcxCacheSnapshot = originalGetMcxCacheSnapshot;
    redisService.setMcxCache = originalSetMcxCache;
    redisService.setSupremeCache = originalSetSupremeCache;
    redisService.invalidateAllGoldRatesCache = originalInvalidateAllGoldRatesCache;
    MCXFetch.findOne = originalFindMcxFetch;
    SupremeChange.findOne = originalFindSupreme;
    bhawService.boardMcxSell = originalBoardMcxSell;
    bhawService.houseMcxLines = originalHouseMcxLines;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    // initMcxScheduler also started storing each new board snapshot.
    resetSnapshotState();
  }
});

test('outside the trading window the timer sleeps, but a new board snapshot still stores the MCX at once', async () => {
  const originals = {
    axiosGet: axios.get,
    getMcxCacheSnapshot: redisService.getMcxCacheSnapshot,
    setMcxCache: redisService.setMcxCache,
    setSupremeCache: redisService.setSupremeCache,
    invalidateAll: redisService.invalidateAllGoldRatesCache,
    findMcxFetch: MCXFetch.findOne,
    findSupreme: SupremeChange.findOne,
    tradingDays: [...schedulerConfig.tradingDays],
    log: console.log,
  };
  const stored = [];
  const supreme = [];
  try {
    // No trading day at all: every moment, this one included, is outside the
    // window, as on a weekend or at night.
    schedulerConfig.tradingDays.clear();
    assert.equal(isWithinTradingWindow(getIstParts(new Date())), false);

    const line = (sell) => ({ label: 'Gold Future MCX', buy: String(sell - 20), sell: String(sell) });
    axios.get = async () => ({
      data: {
        fetched_at: new Date().toISOString(),
        next_fetch_at: new Date(Date.now() + 180_000).toISOString(),
        sources: [
          { source: 'mega_bullion', rows: [line(150720)] },
          { source: 'shri_sai', rows: [line(150720)] },
          { source: 'jmd_patil', rows: [line(153273)] },
        ],
      },
    });
    redisService.getMcxCacheSnapshot = async () => null;
    redisService.setMcxCache = async (snapshot) => { stored.push(snapshot); };
    redisService.setSupremeCache = async (data) => { supreme.push(data); };
    redisService.invalidateAllGoldRatesCache = async () => {};
    MCXFetch.findOne = async () => ({ save: async () => {}, numberOfApiCall: 0 });
    SupremeChange.findOne = () => ({ sort: async () => null });
    console.log = () => {};

    resetSnapshotState();
    bhawService.__internal.resetCache();
    watchBoardSnapshots();
    await bhawService.prefetch();

    const deadline = Date.now() + 5_000;
    while (stored.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(stored.length, 1, 'the snapshot was stored without the timer');
    assert.equal(stored[0].rate, 150720);
    assert.equal(supreme[0].mcx, 150720);
  } finally {
    axios.get = originals.axiosGet;
    redisService.getMcxCacheSnapshot = originals.getMcxCacheSnapshot;
    redisService.setMcxCache = originals.setMcxCache;
    redisService.setSupremeCache = originals.setSupremeCache;
    redisService.invalidateAllGoldRatesCache = originals.invalidateAll;
    MCXFetch.findOne = originals.findMcxFetch;
    SupremeChange.findOne = originals.findSupreme;
    for (const day of originals.tradingDays) schedulerConfig.tradingDays.add(day);
    console.log = originals.log;
    resetSnapshotState();
    bhawService.__internal.resetCache();
  }
});

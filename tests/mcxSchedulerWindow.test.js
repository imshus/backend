const test = require('node:test');
const assert = require('node:assert/strict');

const axios = require('axios');
const redisService = require('../src/services/redis.service');
const MCXFetch = require('../src/models/mcxFetch.model');
const SupremeChange = require('../src/models/supremeChange.model');

const {
  initMcxScheduler,
  __internal: {
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
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  let apiCallCount = 0;

  try {
    axios.get = async () => {
      apiCallCount += 1;
      return {
        data: {
          status: 'success',
          rates: {
            mcx_gold: 145320,
          },
        },
      };
    };

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
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

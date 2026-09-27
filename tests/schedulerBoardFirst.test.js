/**
 * The scheduler's MCX is the board's majority figure — the one every
 * bullion card and both screens print — and metals.dev only stands in
 * when the board has no MCX line at all. A silent house's followers used
 * to be priced on metals.dev's figure, a number no card showed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const redisService = require('../src/services/redis.service');
const MCXFetch = require('../src/models/mcxFetch.model');
const SupremeChange = require('../src/models/supremeChange.model');
const bhawService = require('../src/services/bhaw.service');
const { fetchAndStoreMcxRate } = require('../src/services/mcxScheduler.service');

const BOARD_MAJORITY = 150720;
const METALS = 150881;

const FEED = [
  { source: 'jmd_patil', name: 'JMD Patil', cash_bhaw: '-3073', rtgs_bhaw: '2127',
    rows: [{ label: 'Gold Future MCX', sell: '153273' }] },
  { source: 'mega_bullion', name: 'Mega Bullion', cash_bhaw: null, rtgs_bhaw: null,
    rows: [{ label: 'Gold Future MCX', sell: String(BOARD_MAJORITY) }] },
  { source: 'shri_sai', name: 'Shri Sai Jewels', cash_bhaw: null, rtgs_bhaw: '4450',
    rows: [{ label: 'Gold Future MCX', sell: String(BOARD_MAJORITY) }] },
  { source: 'shri_ganesh', name: 'Shri Ganesh Bullion', cash_bhaw: null, rtgs_bhaw: null,
    rows: [{ label: 'Gold Future MCX', sell: String(BOARD_MAJORITY) }] },
];

const original = {
  axiosGet: axios.get,
  boardMcxSell: bhawService.boardMcxSell,
  houseMcxLines: bhawService.houseMcxLines,
  getMcxCacheSnapshot: redisService.getMcxCacheSnapshot,
  setMcxCache: redisService.setMcxCache,
  setSupremeCache: redisService.setSupremeCache,
  invalidateAll: redisService.invalidateAllGoldRatesCache,
  findMcxFetch: MCXFetch.findOne,
  findSupreme: SupremeChange.findOne,
};

test.after(() => {
  axios.get = original.axiosGet;
  bhawService.boardMcxSell = original.boardMcxSell;
  bhawService.houseMcxLines = original.houseMcxLines;
  redisService.getMcxCacheSnapshot = original.getMcxCacheSnapshot;
  redisService.setMcxCache = original.setMcxCache;
  redisService.setSupremeCache = original.setSupremeCache;
  redisService.invalidateAllGoldRatesCache = original.invalidateAll;
  MCXFetch.findOne = original.findMcxFetch;
  SupremeChange.findOne = original.findSupreme;
});

/** Everything the scheduler touches, stubbed; returns what it stored. */
function arm({ board, metals }) {
  const seen = { stored: null, metalsCalls: 0 };
  process.env.METALS_API_KEY = 'test-key';
  bhawService.boardMcxSell = async () => board;
  bhawService.houseMcxLines = async () => ({});
  axios.get = async (url) => {
    if (String(url).includes('metals.dev')) {
      seen.metalsCalls += 1;
      if (metals === null) throw new Error('metals down');
      return { data: { status: 'success', rates: { mcx_gold: metals } } };
    }
    return { data: FEED };
  };
  redisService.getMcxCacheSnapshot = async () => null;
  redisService.setMcxCache = async (snapshot) => { seen.stored = snapshot; };
  redisService.setSupremeCache = async () => {};
  redisService.invalidateAllGoldRatesCache = async () => {};
  MCXFetch.findOne = async () => ({ save: async () => {}, numberOfApiCall: 0 });
  SupremeChange.findOne = () => ({ sort: async () => null });
  return seen;
}

test('the board majority is the MCX, and metals.dev is not even asked', async () => {
  const seen = arm({ board: BOARD_MAJORITY, metals: METALS });
  const result = await fetchAndStoreMcxRate({ phase: 'scheduled' });
  assert.equal(result.success, true);
  assert.equal(result.liveRate, BOARD_MAJORITY);
  assert.equal(seen.stored.rate, BOARD_MAJORITY);
  assert.equal(seen.stored.source, 'board');
  assert.equal(seen.metalsCalls, 0, 'metals.dev must not be called while the board answers');
});

test('metals.dev stands in only when the board has no MCX line', async () => {
  const seen = arm({ board: null, metals: METALS });
  const result = await fetchAndStoreMcxRate({ phase: 'scheduled' });
  assert.equal(result.success, true);
  assert.equal(result.liveRate, METALS);
  assert.equal(seen.stored.source, 'metals.dev');
  assert.equal(seen.metalsCalls, 1);
});

test('no board and no metals.dev is a failed fetch, never a made-up rate', async () => {
  const seen = arm({ board: null, metals: null });
  const result = await fetchAndStoreMcxRate({ phase: 'scheduled' });
  assert.equal(result.success, false);
  assert.equal(seen.stored, null);
});

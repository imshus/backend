/**
 * The scheduler's MCX is the board's majority figure — the one every
 * bullion card and both screens print — and nothing else: metals.dev, once
 * the fallback, was removed on 6 Oct 2026. With no MCX line on the board
 * the fetch fails and the last stored rate stands.
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

// Each house's three rows; cash_bhaw / rtgs_bhaw are the tracker's diffs
// (side sell less the MCX buy).
const FEED = [
  { source: 'jmd_patil', name: 'JMD Patil', cash_bhaw: '-3073', rtgs_bhaw: '2127',
    rows: [
      { label: 'Gold Future MCX', buy: '153246', sell: '153273' },
      { label: '99.50 Gold Cash', buy: null, sell: '150173' },
      { label: '99.50 Gold RTGS', buy: null, sell: '155373' },
    ] },
  { source: 'mega_bullion', name: 'Mega Bullion', cash_bhaw: null, rtgs_bhaw: null,
    rows: [
      { label: 'Gold Future MCX', buy: String(BOARD_MAJORITY - 20), sell: String(BOARD_MAJORITY) },
      { label: '99.50 Gold Cash', buy: null, sell: null },
      { label: '99.50 Gold RTGS', buy: null, sell: null },
    ] },
  { source: 'shri_sai', name: 'Shri Sai Jewels', cash_bhaw: null, rtgs_bhaw: '4470',
    rows: [
      { label: 'Gold Future MCX', buy: String(BOARD_MAJORITY - 20), sell: String(BOARD_MAJORITY) },
      { label: '99.50 Gold Cash', buy: null, sell: null },
      { label: '99.50 Gold RTGS', buy: '-', sell: String(BOARD_MAJORITY + 4450) },
    ] },
  { source: 'shri_ganesh', name: 'Shri Ganesh Bullion', cash_bhaw: null, rtgs_bhaw: null,
    rows: [
      { label: 'Gold Future MCX', buy: String(BOARD_MAJORITY - 20), sell: String(BOARD_MAJORITY) },
      { label: '99.50 Gold Cash', buy: null, sell: null },
      { label: '99.50 Gold RTGS', buy: null, sell: null },
    ] },
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
function arm({ board }) {
  const seen = { stored: null, metalsCalls: 0 };
  bhawService.boardMcxSell = async () => board;
  bhawService.houseMcxLines = async () => ({});
  axios.get = async (url) => {
    if (String(url).includes('metals.dev')) seen.metalsCalls += 1;
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

test('the board majority is the MCX, and metals.dev is never asked', async () => {
  const seen = arm({ board: BOARD_MAJORITY });
  const result = await fetchAndStoreMcxRate({ phase: 'scheduled' });
  assert.equal(result.success, true);
  assert.equal(result.liveRate, BOARD_MAJORITY);
  assert.equal(seen.stored.rate, BOARD_MAJORITY);
  assert.equal(seen.stored.source, 'board');
  assert.equal(seen.metalsCalls, 0, 'metals.dev is gone and must never be called');
});

test('no MCX line on the board is a failed fetch, never a made-up rate', async () => {
  const seen = arm({ board: null });
  const result = await fetchAndStoreMcxRate({ phase: 'scheduled' });
  assert.equal(result.success, false);
  assert.equal(seen.stored, null);
  assert.equal(seen.metalsCalls, 0, 'metals.dev is gone and must never be called');
});

// ── Every 3-minute snapshot stored as it arrives ────────────────────────────

const {
  watchBoardSnapshots,
  __internal: { resetSnapshotState },
} = require('../src/services/mcxScheduler.service');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 5_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return false;
    await sleep(5);
  }
  return true;
};

/** The real board, fed one snapshot by the stubbed feed; every write recorded. */
function armSnapshots() {
  const seen = { writes: [], supreme: [], invalidations: 0, fetchRecords: 0, payload: null };
  bhawService.boardMcxSell = original.boardMcxSell;
  bhawService.houseMcxLines = original.houseMcxLines;
  axios.get = async () => ({ data: seen.payload });
  redisService.getMcxCacheSnapshot = async () => seen.writes[seen.writes.length - 1] || null;
  redisService.setMcxCache = async (snapshot) => { seen.writes.push(snapshot); };
  redisService.setSupremeCache = async (data) => { seen.supreme.push(data); };
  redisService.invalidateAllGoldRatesCache = async () => { seen.invalidations += 1; };
  MCXFetch.findOne = async () => ({ save: async () => { seen.fetchRecords += 1; }, numberOfApiCall: 0 });
  SupremeChange.findOne = () => ({ sort: async () => null });
  resetSnapshotState();
  bhawService.__internal.resetCache();
  watchBoardSnapshots();
  return seen;
}

/** The feed hands over a snapshot, as the keep-warm stream does every 3 minutes. */
const arrive = async (seen, fetchedAt, sources = FEED) => {
  seen.payload = { fetched_at: fetchedAt, next_fetch_at: new Date(Date.now() + 180_000).toISOString(), sources };
  bhawService.__internal.resetCache();
  await bhawService.prefetch();
};

const quiet = async (fn) => {
  const { log } = console;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

test('a new snapshot writes the MCX and the supreme rates at once; the same snapshot, or the timer after it, writes nothing more', async () => {
  const seen = armSnapshots();
  try {
    await quiet(async () => {
      await arrive(seen, '2026-10-16T10:00:00Z');
      assert.ok(await waitFor(() => seen.writes.length === 1), 'stored without waiting for the timer');
      assert.equal(seen.writes[0].rate, BOARD_MAJORITY);
      assert.equal(seen.supreme.length, 1);
      assert.equal(seen.supreme[0].mcx, BOARD_MAJORITY);
      assert.equal(seen.fetchRecords, 1, 'the same MCXFetch record as a timer fetch');

      // The stream reconnects and sends the snapshot it already sent.
      await arrive(seen, '2026-10-16T10:00:00Z');
      // The trading-window timer comes round on the same board.
      const timer = await fetchAndStoreMcxRate({ phase: 'scheduled' });
      await sleep(30);
      assert.equal(timer.success, true);
      assert.equal(timer.alreadyStored, true);
      assert.equal(seen.writes.length, 1, 'one write per snapshot');
      assert.equal(seen.fetchRecords, 1);
    });
  } finally {
    resetSnapshotState();
    bhawService.__internal.resetCache();
  }
});

test('each snapshot is written; only one that moves the MCX or a house line clears the computed rates', async () => {
  const seen = armSnapshots();
  try {
    await quiet(async () => {
      await arrive(seen, '2026-10-16T10:00:00Z');
      assert.ok(await waitFor(() => seen.writes.length === 1));
      assert.equal(seen.invalidations, 0, 'nothing stored before it to move from');

      await arrive(seen, '2026-10-16T10:03:00Z');
      assert.ok(await waitFor(() => seen.writes.length === 2), 'the next snapshot is written too');
      assert.equal(seen.invalidations, 0, 'the same figures clear nothing');

      const moved = FEED.map((house) => ({
        ...house,
        rows: house.rows.map((row) => (/mcx/i.test(row.label) && house.source !== 'jmd_patil'
          ? { ...row, sell: String(BOARD_MAJORITY + 300) }
          : row)),
      }));
      await arrive(seen, '2026-10-16T10:06:00Z', moved);
      assert.ok(await waitFor(() => seen.writes.length === 3));
      assert.equal(seen.writes[2].rate, BOARD_MAJORITY + 300);
      assert.equal(seen.invalidations, 1, 'the MCX moved: the computed rates are cleared');
      assert.equal(seen.fetchRecords, 3);
    });
  } finally {
    resetSnapshotState();
    bhawService.__internal.resetCache();
  }
});

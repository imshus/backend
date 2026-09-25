const axios = require('axios');

/**
 * Live bhaw feed (premium/discount over MCX) for both supported vendors.
 *
 * GET -> [ { source: 'jmd_patil',    name, cash_bhaw, rtgs_bhaw, ... },
 *          { source: 'mega_bullion', name, cash_bhaw, rtgs_bhaw, ... } ]
 *
 * The endpoint returns an ARRAY containing every vendor, so the caller picks
 * the one the business selected rather than trusting position or a single
 * "active" record.
 */
const BHAW_URL = 'https://17gdivfex7.execute-api.ap-south-1.amazonaws.com/bhaw';
const CACHE_TTL_MS = 30_000;

const SOURCES = {
  JMD_PATIL: 'jmd_patil',
  MEGA_BULLION: 'mega_bullion',
};

let cache = { rows: null, fetchedAt: 0 };

const toFiniteNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const fetchRows = async (force = false) => {
  const now = Date.now();
  if (!force && cache.rows && now - cache.fetchedAt < CACHE_TTL_MS) return cache.rows;

  try {
    const response = await axios.get(BHAW_URL, { timeout: 5000 });
    // Tolerate both the array form and a bare object, in case the upstream
    // shape changes again.
    const rows = Array.isArray(response.data)
      ? response.data
      : response.data
        ? [response.data]
        : [];
    if (!rows.length) return cache.rows;

    cache = { rows, fetchedAt: now };
    return rows;
  } catch (error) {
    console.warn('[Bhaw] Failed to fetch bhaw feed:', error.message);
    return cache.rows; // serve stale rather than dropping to a wrong rate
  }
};

/**
 * @param {string} source one of SOURCES
 * @returns {Promise<{ cashBhaw: number, rtgsBhaw: number, name: string } | null>}
 */
const getBhawForSource = async (source) => {
  const rows = await fetchRows();
  if (!rows) return null;

  const wanted = String(source || '').toLowerCase();
  const row = rows.find((entry) => String(entry?.source || '').toLowerCase() === wanted);
  if (!row) {
    console.warn(`[Bhaw] Feed does not contain source "${source}".`);
    return null;
  }

  const cashBhaw = toFiniteNumber(row.cash_bhaw);
  const rtgsBhaw = toFiniteNumber(row.rtgs_bhaw);
  if (cashBhaw === null || rtgsBhaw === null) {
    console.warn(`[Bhaw] Source "${source}" has not published rates yet.`);
    return null;
  }

  return { cashBhaw, rtgsBhaw, name: row.name || source };
};

/** Back-compat helper used before both vendors were served from this feed. */
const getJmdBhaw = () => getBhawForSource(SOURCES.JMD_PATIL);

/** One house's own "Gold Future MCX" sell, or null when it has not published one. */
const futureMcxSellOf = (vendor) => {
  const row = (Array.isArray(vendor?.rows) ? vendor.rows : []).find((entry) =>
    /gold\s*future\s*mcx/i.test(String(entry?.label || '')),
  );
  const sell = Number(String(row?.sell ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(sell) && sell > 0 ? Math.round(sell) : null;
};

/** Quotes within this share of each other are taken as the same contract. */
const SAME_CONTRACT_SPREAD = 0.004;

/**
 * The MCX figure most houses agree on.
 *
 * The houses do not all quote the same contract: on 25 Sep 2026 JMD Patil's
 * "Gold Future MCX" was the December contract (1,54,2xx) while Mega Bullion,
 * Shri Sai and Shri Ganesh quoted the October near month (1,51,9xx), the
 * figure market apps show. Taking the first house on the feed, as this used
 * to, put JMD's December figure on every shop's MCX. Each quote opens a
 * window of the quotes within SAME_CONTRACT_SPREAD above it (one contract);
 * the window holding the most houses wins, a tie going to the lower one, the
 * near month. A window, not fixed groups, so one stale low board cannot split
 * a real cluster and win the tie. Its lower median is returned — a real
 * quote, never an average across two contracts. The app's bhawApi
 * majorityMcx is the same rule.
 */
const majorityMcx = (values) => {
  const quotes = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!quotes.length) return null;
  let best = [];
  for (let i = 0; i < quotes.length; i += 1) {
    const window = quotes.filter((quote, j) => j >= i && quote - quotes[i] <= quotes[i] * SAME_CONTRACT_SPREAD);
    if (window.length > best.length) best = window;
  }
  return Math.round(best[Math.floor((best.length - 1) / 2)]);
};

/**
 * Every house's own MCX line, keyed by source — what the scheduler compares
 * between ticks: a shop's RTGS and Cash stand on its house's line, so a move
 * in that line has to refresh the stored rates even when the majority holds.
 */
const houseMcxLines = async () => {
  const rows = await fetchRows();
  if (!rows) return {};
  const lines = {};
  for (const vendor of rows) {
    const source = String(vendor?.source || '').toLowerCase();
    if (source) lines[source] = futureMcxSellOf(vendor);
  }
  return lines;
};

/**
 * The market's MCX off the board: the figure most houses agree on (see
 * majorityMcx). Null when no house has published one. Never throws.
 */
const boardMcxSell = async () => {
  const rows = await fetchRows();
  if (!rows) return null;
  return majorityMcx(rows.map(futureMcxSellOf));
};

/**
 * The followed house's own "Gold Future MCX" sell. Its bhaw is quoted over
 * this line, whichever contract it is, so the house's RTGS and Cash are built
 * on it: MCX-majority plus JMD's bhaw would put a JMD shop ~2,300 below the
 * rate JMD actually charges. Null when that house has no such line.
 */
const houseMcxSell = async (source) => {
  const rows = await fetchRows();
  if (!rows) return null;
  const wanted = String(source || '').toLowerCase();
  const vendor = rows.find((entry) => String(entry?.source || '').toLowerCase() === wanted);
  return vendor ? futureMcxSellOf(vendor) : null;
};

/** Fetch the feed now, or hand back the fresh cache. Never throws. */
const prefetch = () => fetchRows().catch(() => null);

const KEEP_WARM_MS = 25_000;

/**
 * Refresh the feed on a timer so no user request waits on the vendor. The
 * cache used to expire between requests and the next reader paid the round
 * trip (0.7 to 0.9 s measured). An interval shorter than the TTL keeps it
 * always fresh; a failed refresh keeps serving the last good rows.
 */
const startKeepWarm = () => {
  void fetchRows(true).catch(() => null);
  const timer = setInterval(() => {
    void fetchRows(true).catch(() => null);
  }, KEEP_WARM_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
};

module.exports = {
  SOURCES,
  getBhawForSource,
  getJmdBhaw,
  boardMcxSell,
  houseMcxSell,
  houseMcxLines,
  majorityMcx,
  prefetch,
  startKeepWarm,
};

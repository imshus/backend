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

module.exports = { SOURCES, getBhawForSource, getJmdBhaw, prefetch, startKeepWarm };

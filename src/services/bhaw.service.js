const axios = require('axios');
const { createSseParser, snapshotPayload } = require('./sseFrames');

/**
 * The bullion houses' rate board (bhaw = premium/discount over MCX), as the
 * server prices on it.
 *
 * Source: the owner's 3-minute stream (MCX_3MINUTE_STREAMING), server-sent
 * events. On connect it sends one snapshot
 *
 *   { fetched_at, next_fetch_at, errors,
 *     sources: [ { source: 'jmd_patil', name, cash_bhaw, rtgs_bhaw, rows, ok, ... }, ... ] }
 *
 * then a new one every 3 minutes, with a ': ping' comment and a 'heartbeat'
 * event every 20 s in between (liveness only, never rates).
 *
 * The phone's Home and Settings show the live stream (MCX_LIVE_STEAMING,
 * several updates a second). Scans, invoices and the MCX scheduler are priced
 * here on the 3-minute snapshot with the same arithmetic, so the two can
 * differ by up to three minutes of market movement.
 *
 * The snapshot holds every house, so the caller picks the one the business
 * selected rather than trusting position or a single "active" record.
 */
const DEFAULT_STREAM_URL = 'https://jmd.mrpscan.com/api/3min/stream';
/** How long a snapshot without next_fetch_at (the old bare array) is fresh. */
const CACHE_TTL_MS = 30_000;
/** A snapshot with next_fetch_at stays fresh this long past it. */
const NEXT_FETCH_GRACE_MS = 90_000;
/** A one-shot read gives up after this, connect included. */
const READ_DEADLINE_MS = 8_000;
const SSE_HEADERS = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };

const SOURCES = {
  JMD_PATIL: 'jmd_patil',
  MEGA_BULLION: 'mega_bullion',
  SHRI_SAI: 'shri_sai',
  SHRI_GANESH: 'shri_ganesh',
};

/** What each house is called on screen, so the app and the server agree. */
const SOURCE_NAMES = {
  jmd_patil: 'JMD Patil',
  mega_bullion: 'Mega Bullion',
  shri_sai: 'Shri Sai Jewels',
  shri_ganesh: 'Shri Ganesh Bullion',
};

const emptyCache = () => ({
  rows: null,
  receivedAt: 0,
  freshUntil: 0,
  fetchedAt: null,
  nextFetchAt: null,
  // After a read that failed or brought nothing to price on, no new read
  // before this; the last board (or none) is served at once meanwhile.
  retryAfter: 0,
});

let cache = emptyCache();

/**
 * A figure off the feed, or null when the house has not published it. The
 * feed sends `null` for an unpublished bhaw; Number(null) is 0, which
 * counted a silent house as live with a bhaw of nothing and priced its
 * followers at bare MCX. Reads the way the app's bhawApi does, commas
 * stripped, so a house is live on the same terms on both sides. The phone's
 * Home and Settings read the live stream and the server the 3-minute
 * snapshot, so the figures themselves can differ by up to three minutes of
 * market movement.
 */
const toFiniteNumber = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/,/g, '').trim();
  if (text === '') return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
};

let streamUrl = null;

/** MCX_3MINUTE_STREAMING, read when first needed so requiring this opens nothing. */
const threeMinuteStreamUrl = () => {
  if (streamUrl) return streamUrl;
  try {
    streamUrl = require('../config/env').mcx.threeMinuteStreamUrl || DEFAULT_STREAM_URL;
  } catch (error) {
    // A test or script without the full server environment.
    streamUrl = process.env.MCX_3MINUTE_STREAMING || DEFAULT_STREAM_URL;
  }
  return streamUrl;
};

/**
 * One snapshot's houses and times, or null when the payload is not a board.
 * Takes the stream's { fetched_at, next_fetch_at, sources: [...] } and the
 * old bare array alike. A house marked ok: false (its own board failed) is
 * left out, so it reads exactly like a house that is not live today; `down`
 * counts the houses left out that way.
 */
const normalizePayload = (payload) => {
  const wrapped = Boolean(payload)
    && !Array.isArray(payload)
    && typeof payload === 'object'
    && Array.isArray(payload.sources);
  if (!wrapped && !Array.isArray(payload)) return null;
  const list = (wrapped ? payload.sources : payload)
    .filter((entry) => entry && typeof entry === 'object');
  const rows = list.filter((entry) => entry.ok !== false);
  return {
    rows,
    down: list.length - rows.length,
    fetchedAt: wrapped ? payload.fetched_at ?? null : null,
    nextFetchAt: wrapped ? payload.next_fetch_at ?? null : null,
  };
};

/**
 * Whether a snapshot is a board to price on: at least one house live, or
 * every house it lists marked down — then that is the board, with nobody
 * live on it until the next snapshot, never the last board passed off as
 * current. A snapshot with no houses at all says nothing about the market,
 * so the last board stands, as it does when a read fails.
 */
const isBoard = (snapshot) => Boolean(snapshot) && (snapshot.rows.length > 0 || snapshot.down > 0);

const isStream = (body) => Boolean(body) && typeof body.on === 'function';

/** Closes a response stream without an unhandled 'error' on the way out. */
const discard = (body) => {
  if (!body || typeof body.destroy !== 'function') return;
  if (typeof body.on === 'function') body.on('error', () => {});
  body.destroy();
};

/**
 * Until when a snapshot is fresh: next_fetch_at plus a grace, or the plain
 * TTL when the payload carries no times. One that lands already past its
 * own next fetch (the 3-minute server is behind) is still held for the TTL,
 * so a stalled upstream is not re-read on every request.
 */
const freshUntilOf = (snapshot, now) => {
  const nextFetch = Date.parse(snapshot.nextFetchAt ?? '');
  if (!Number.isFinite(nextFetch)) return now + CACHE_TTL_MS;
  return Math.max(nextFetch + NEXT_FETCH_GRACE_MS, now + CACHE_TTL_MS);
};

/**
 * Makes a snapshot the board, unless an older one arrives after a newer.
 * Returns whether it did.
 */
const store = (snapshot) => {
  const incoming = Date.parse(snapshot.fetchedAt ?? '');
  const held = Date.parse(cache.fetchedAt ?? '');
  if (cache.rows && Number.isFinite(incoming) && Number.isFinite(held) && incoming < held) return false;
  if (!snapshot.rows.length) {
    console.warn(`[Bhaw] Every house on the 3-minute snapshot ${snapshot.fetchedAt || ''} is marked down; none is live until the next one.`);
  }
  const now = Date.now();
  cache = {
    rows: snapshot.rows,
    receivedAt: now,
    freshUntil: freshUntilOf(snapshot, now),
    fetchedAt: snapshot.fetchedAt,
    nextFetchAt: snapshot.nextFetchAt,
    retryAfter: 0,
  };
  return true;
};

/**
 * One read of the 3-minute stream: connect, take the first snapshot event
 * (the server sends one on connect), close. Pings and heartbeats on the way
 * are skipped. Rejects when no snapshot comes within READ_DEADLINE_MS.
 * A response body that is not a stream is taken as the payload itself.
 */
const readSnapshot = (url = threeMinuteStreamUrl()) => new Promise((resolve, reject) => {
  const controller = new AbortController();
  let body = null;
  let settled = false;

  const finish = (error, snapshot) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (body) discard(body);
    else controller.abort();
    if (error) reject(error);
    else resolve(snapshot);
  };

  const deadline = setTimeout(
    () => finish(new Error(`no snapshot from the 3-minute feed within ${READ_DEADLINE_MS / 1000} s`)),
    READ_DEADLINE_MS,
  );
  if (typeof deadline.unref === 'function') deadline.unref();

  Promise.resolve()
    .then(() => axios.get(url, {
      responseType: 'stream',
      headers: SSE_HEADERS,
      signal: controller.signal,
    }))
    .then((response) => {
      const data = response?.data;
      if (settled) {
        if (isStream(data)) discard(data);
        return;
      }
      if (!isStream(data)) {
        const snapshot = normalizePayload(data);
        if (snapshot) finish(null, snapshot);
        else finish(new Error('the 3-minute feed answered without a rate board'));
        return;
      }
      body = data;
      const parser = createSseParser((event) => {
        if (settled) return;
        const snapshot = normalizePayload(snapshotPayload(event));
        if (snapshot) finish(null, snapshot);
      });
      data.on('error', (error) => finish(error));
      data.on('end', () => finish(new Error('the 3-minute feed closed before a snapshot')));
      data.on('close', () => finish(new Error('the 3-minute feed closed before a snapshot')));
      data.on('data', (chunk) => {
        if (!settled) parser.push(chunk);
      });
    })
    .catch((error) => {
      if (isStream(error?.response?.data)) discard(error.response.data);
      finish(error);
    });
});

let pendingRead = null;

/** The last board stays (stale rather than a wrong rate); no new read for CACHE_TTL_MS. */
const holdOff = (reason) => {
  console.warn('[Bhaw] Failed to fetch bhaw feed:', reason);
  cache.retryAfter = Date.now() + CACHE_TTL_MS;
};

/**
 * One read of the 3-minute stream made the board, shared by every caller
 * that asks while it is in flight. A read that fails, times out or brings
 * nothing to price on holds off the next one for CACHE_TTL_MS, so a request
 * that looks the board up several times (feedStamp, then the recompute)
 * waits on one read at most. The keep-warm subscription brings the board
 * back as soon as the stream does.
 */
const refresh = () => {
  if (!pendingRead) {
    pendingRead = readSnapshot()
      .then((snapshot) => {
        if (!isBoard(snapshot)) holdOff('the 3-minute feed sent a snapshot with no houses');
        else if (!store(snapshot)) holdOff('the 3-minute feed sent an older snapshot than the one held');
      })
      .catch((error) => holdOff(error.message))
      .finally(() => {
        pendingRead = null;
      });
  }
  return pendingRead;
};

const fetchRows = async (force = false) => {
  const now = Date.now();
  if (!force && cache.rows && now < cache.freshUntil) return cache.rows;
  if (!force && now < cache.retryAfter) return cache.rows;
  await refresh();
  return cache.rows;
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

  // Each side stands on its own: a house that quotes RTGS and no cash
  // (Shri Sai) prices RTGS off its board; the side it has not published is
  // null, and the caller falls back for that side alone.
  const cashBhaw = toFiniteNumber(row.cash_bhaw);
  const rtgsBhaw = toFiniteNumber(row.rtgs_bhaw);
  if (cashBhaw === null && rtgsBhaw === null) {
    console.warn(`[Bhaw] Source "${source}" has not published rates yet.`);
    return null;
  }

  return { cashBhaw, rtgsBhaw, name: row.name || SOURCE_NAMES[wanted] || source };
};

/**
 * What the followed house's figures stand on right now, as one string: its
 * MCX line and both bhaw sides, or 'off' while it is not live. A cached
 * rate is served only while this still reads the same, so a move on the
 * board reaches scans with the next 3-minute snapshot, on weekends included.
 */
const feedStamp = async (source) => {
  const bhaw = await getBhawForSource(source);
  if (!bhaw) return 'off';
  const line = await houseMcxSell(source);
  return `${line}|${bhaw.cashBhaw}|${bhaw.rtgsBhaw}`;
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
 * majorityMcx is the same rule, run on the live stream for Home and
 * Settings; the server runs it on the 3-minute snapshot, so the two can
 * differ by up to three minutes of market movement.
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

/** A subscription that hears nothing at all (not even a ping) this long is dropped. */
const IDLE_LIMIT_MS = 60_000;
const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;

let subscription = null;

/**
 * Hold one stream to the 3-minute feed open so no user request waits on
 * it: every snapshot event becomes the board as it arrives. Any bytes
 * (the 20 s ping and heartbeat included) count as the line being alive;
 * 60 s of silence drops the connection. A dropped connection is retried
 * after 2 s, doubling to 60 s, back to 2 s once a snapshot comes through.
 * Meanwhile the last snapshot keeps being served. Calling it again while it
 * runs does nothing.
 */
const startKeepWarm = () => {
  if (subscription) return;
  const sub = { stopped: false, conn: null, retryTimer: null, retryMs: RETRY_FIRST_MS };
  subscription = sub;

  const connect = () => {
    sub.retryTimer = null;
    if (sub.stopped) return;
    const conn = {
      closed: false,
      body: null,
      controller: new AbortController(),
      idleTimer: null,
      snapshots: 0,
    };

    const close = (reason) => {
      if (conn.closed) return;
      conn.closed = true;
      clearTimeout(conn.idleTimer);
      if (conn.body) discard(conn.body);
      else conn.controller.abort();
      if (sub.stopped) return;
      const wait = sub.retryMs;
      sub.retryMs = Math.min(sub.retryMs * 2, RETRY_MAX_MS);
      console.warn(`[Bhaw] 3-minute feed ${reason}; reconnecting in ${wait / 1000} s`);
      sub.retryTimer = setTimeout(connect, wait);
      if (typeof sub.retryTimer.unref === 'function') sub.retryTimer.unref();
    };
    conn.close = close;
    sub.conn = conn;

    const armIdle = () => {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = setTimeout(() => close(`silent for ${IDLE_LIMIT_MS / 1000} s`), IDLE_LIMIT_MS);
      if (typeof conn.idleTimer.unref === 'function') conn.idleTimer.unref();
    };
    armIdle();

    Promise.resolve()
      .then(() => axios.get(threeMinuteStreamUrl(), {
        responseType: 'stream',
        headers: SSE_HEADERS,
        signal: conn.controller.signal,
      }))
      .then((response) => {
        const data = response?.data;
        if (conn.closed) {
          if (isStream(data)) discard(data);
          return;
        }
        if (!isStream(data)) {
          // Not a stream (a stubbed client): take the board it handed back
          // and come round again on the backoff.
          const snapshot = normalizePayload(data);
          if (isBoard(snapshot)) store(snapshot);
          close('answered without a stream');
          return;
        }
        conn.body = data;
        const parser = createSseParser((event) => {
          if (conn.closed) return;
          const snapshot = normalizePayload(snapshotPayload(event));
          if (!isBoard(snapshot)) return;
          store(snapshot);
          sub.retryMs = RETRY_FIRST_MS;
          conn.snapshots += 1;
          if (conn.snapshots === 1) {
            console.log(`[Bhaw] 3-minute feed connected (snapshot ${snapshot.fetchedAt || 'without a time'})`);
          }
        });
        data.on('error', (error) => close(`failed: ${error.message}`));
        data.on('end', () => close('ended'));
        data.on('close', () => close('closed'));
        data.on('data', (chunk) => {
          if (conn.closed) return;
          armIdle();
          parser.push(chunk);
        });
      })
      .catch((error) => {
        if (isStream(error?.response?.data)) discard(error.response.data);
        close(`failed: ${error.message}`);
      });
  };

  connect();
};

/** Closes the subscription startKeepWarm opened, and stops it reconnecting. */
const stopKeepWarm = () => {
  const sub = subscription;
  if (!sub) return;
  subscription = null;
  sub.stopped = true;
  clearTimeout(sub.retryTimer);
  if (sub.conn) sub.conn.close('stopped');
};

module.exports = {
  SOURCES,
  SOURCE_NAMES,
  feedStamp,
  getBhawForSource,
  getJmdBhaw,
  boardMcxSell,
  houseMcxSell,
  houseMcxLines,
  majorityMcx,
  normalizePayload,
  prefetch,
  readSnapshot,
  startKeepWarm,
  stopKeepWarm,
  __internal: {
    resetCache: () => {
      cache = emptyCache();
      pendingRead = null;
    },
    cacheState: () => ({ ...cache }),
  },
};

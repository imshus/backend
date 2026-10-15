/**
 * Scan records in this process's own memory (SCAN_STORE=memory, the default).
 *
 * A scan used to live in Redis (us-east-1, ~190 ms a call from the Mumbai
 * API) for 24 hours, and every step of a scan read and wrote it several
 * times in a row: three to six round trips after Calculate alone. The record
 * is only ever needed by the phone that is scanning, for as long as it is
 * scanning, so it is held here instead and dropped once the scan is over:
 *
 *   - finished: an invoice was made for it, or the same person started a
 *     newer scan (superseded). It is then dropped once nothing has touched
 *     it for FINISHED_GRACE_MS, so a request already in flight on it (the
 *     same login on a second phone, a card still open behind the invoice)
 *     still completes;
 *   - idle: nothing has read or written it for IDLE_MS (30 minutes);
 *   - over the cap: the least recently used record goes first.
 *
 * Records are kept as JSON text, exactly as Redis held them, so every read
 * hands back a fresh copy and nobody can change a stored record by mutating
 * what they were given.
 *
 * One process holds them: the in-flight speculative reads and the prepared
 * image views already assume one server process, and a restart or deploy
 * drops every scan in progress (the phone is then asked to scan again).
 */

const minutes = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n * 60 * 1000 : fallback;
};
const seconds = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : fallback;
};
const count = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const IDLE_MS = minutes(process.env.SCAN_STORE_IDLE_MINUTES, 30 * 60 * 1000);
const FINISHED_GRACE_MS = seconds(process.env.SCAN_STORE_FINISHED_GRACE_SECONDS, 2 * 60 * 1000);
const MAX_ENTRIES = count(process.env.SCAN_STORE_MAX_ENTRIES, 2000);
const SWEEP_EVERY_MS = 60 * 1000;

/** scanId -> { json, owner, touchedAt, finishedAt } in least-recently-used order. */
const records = new Map();
/** `${businessId}:${userId}` -> scanId: the scan each person started last. */
const latest = new Map();

let sweeper = null;

const ownerKey = (businessId, userId) => `${businessId}:${userId}`;

const limitOf = (entry) => (entry.finishedAt ? FINISHED_GRACE_MS : IDLE_MS);

const isExpired = (entry, now) => now - entry.touchedAt > limitOf(entry);

/** Moves an entry to the most-recently-used end and stamps it. */
const touch = (scanId, entry, now = Date.now()) => {
  entry.touchedAt = now;
  records.delete(scanId);
  records.set(scanId, entry);
};

const drop = (scanId, reason) => {
  const entry = records.get(scanId);
  if (!entry) return false;
  records.delete(scanId);
  if (entry.owner && latest.get(entry.owner) === scanId) latest.delete(entry.owner);
  if (reason) console.info('[SCAN_STORE_DROPPED]', { scanId, reason });
  return true;
};

/** Drops every record past its limit; returns how many went. */
const sweep = (now = Date.now()) => {
  let dropped = 0;
  for (const [scanId, entry] of records) {
    if (isExpired(entry, now)) {
      drop(scanId, null);
      dropped += 1;
    }
  }
  if (dropped) console.info('[SCAN_STORE_SWEPT]', { dropped, kept: records.size });
  return dropped;
};

const startSweeper = () => {
  if (sweeper) return;
  sweeper = setInterval(() => sweep(), SWEEP_EVERY_MS);
  // Never what keeps the process (or a test run) alive.
  if (typeof sweeper.unref === 'function') sweeper.unref();
};

const enforceCap = () => {
  while (records.size > MAX_ENTRIES) {
    // Map order is least recently used first.
    const oldest = records.keys().next();
    if (oldest.done) break;
    drop(oldest.value, 'over the cap');
  }
};

/** The record, or null when there is none or it has expired. Touches it. */
const get = (scanId) => {
  const entry = records.get(String(scanId));
  if (!entry) return null;
  const now = Date.now();
  if (isExpired(entry, now)) {
    drop(String(scanId), entry.finishedAt ? 'finished' : 'idle');
    return null;
  }
  touch(String(scanId), entry, now);
  return JSON.parse(entry.json);
};

/** The record without touching it (housekeeping only), or null. */
const peek = (scanId) => {
  const entry = records.get(String(scanId));
  if (!entry || isExpired(entry, Date.now())) return null;
  return JSON.parse(entry.json);
};

const set = (scanId, data) => {
  const id = String(scanId);
  const existing = records.get(id);
  const owner = data?.businessId && data?.ownerUserId ? ownerKey(data.businessId, data.ownerUserId) : null;
  const entry = {
    json: JSON.stringify(data),
    owner: owner || existing?.owner || null,
    touchedAt: Date.now(),
    finishedAt: existing?.finishedAt || null,
  };
  touch(id, entry, entry.touchedAt);
  enforceCap();
  startSweeper();
};

const remove = (scanId) => {
  drop(String(scanId), null);
};

/**
 * The scan is over (invoiced, or superseded by a newer one): it is dropped
 * once nothing has touched it for FINISHED_GRACE_MS. Returns whether there
 * was a record to finish.
 */
const finish = (scanId, reason) => {
  const id = String(scanId || '');
  const entry = records.get(id);
  if (!entry || entry.finishedAt) return false;
  entry.finishedAt = Date.now();
  console.info('[SCAN_STORE_FINISHED]', { scanId: id, reason });
  if (FINISHED_GRACE_MS === 0) drop(id, reason);
  return true;
};

const getLatest = (businessId, userId) => {
  const scanId = latest.get(ownerKey(businessId, userId));
  return scanId ? String(scanId) : null;
};

const setLatest = (businessId, userId, scanId) => {
  const key = ownerKey(businessId, userId);
  // Re-inserted so the map, too, is in last-written order.
  latest.delete(key);
  latest.set(key, String(scanId));
  while (latest.size > MAX_ENTRIES) {
    const oldest = latest.keys().next();
    if (oldest.done) break;
    latest.delete(oldest.value);
  }
};

module.exports = {
  get,
  peek,
  set,
  remove,
  finish,
  getLatest,
  setLatest,
  sweep,
  size: () => records.size,
  limits: { IDLE_MS, FINISHED_GRACE_MS, MAX_ENTRIES },
  __internal: {
    reset: () => {
      records.clear();
      latest.clear();
    },
    stopSweeper: () => {
      clearInterval(sweeper);
      sweeper = null;
    },
    entry: (scanId) => records.get(String(scanId)) || null,
  },
};

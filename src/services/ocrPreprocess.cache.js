const { prepareImageViews } = require('./ocrViews');

/**
 * Upload-time image view cache.
 *
 * When an image upload lands, the decode and the magnified parts are produced
 * immediately so the /analyze call (or the speculative call) can reuse them
 * instead of paying that cost on its critical path.
 *
 * Correctness guarantees:
 *  - Entries are keyed by scanId:side AND verified against the exact filePath
 *    stored at warm time — a re-uploaded (different) file never matches.
 *  - warmPreprocess REPLACES any existing entry for the key, so a re-upload
 *    of the same side always supersedes the old result.
 *  - Reading an entry does not consume it: a speculative analysis and the
 *    real one both need the same views, and making the first reader destroy
 *    them put a full decode back on the second one's critical path.
 *  - Any warm failure deletes the entry; analyze falls back to on-demand
 *    preparation from the file on disk — identical output either way.
 *
 * These entries are megabytes each, so the map is bounded: the oldest entry
 * is dropped once MAX_ENTRIES is reached, and stale ones expire on their own.
 */

const MAX_ENTRY_AGE_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 40;

/** @type {Map<string, { promise: Promise<object>, filePath: string, createdAt: number }>} */
const entries = new Map();

const keyFor = (scanId, side) => `${scanId}:${side}`;

const pruneStale = () => {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (now - entry.createdAt > MAX_ENTRY_AGE_MS) entries.delete(key);
  }
  // Map iterates in insertion order, so the first keys are the oldest.
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
};

const warmPreprocess = (scanId, side, filePath) => {
  if (!scanId || !side || !filePath) return;

  const key = keyFor(scanId, side);
  const promise = prepareImageViews(filePath);
  entries.delete(key);
  entries.set(key, { promise, filePath, createdAt: Date.now() });
  pruneStale();

  promise.catch((error) => {
    console.error('[OCR_PREPROCESS_WARM_FAILED]', {
      scanId,
      side,
      error: error?.message || String(error),
    });
    const current = entries.get(key);
    if (current && current.promise === promise) {
      entries.delete(key);
    }
  });
};

/** The prepared views for this scan's exact file, or null. Does not consume. */
const takePreprocessed = (scanId, side, filePath) => {
  if (!scanId || !side || !filePath) return null;
  pruneStale();

  const entry = entries.get(keyFor(scanId, side));
  if (!entry) return null;
  if (entry.filePath !== filePath) {
    // Stale entry for a superseded upload — never reuse; analyze goes on-demand.
    return null;
  }
  return entry.promise;
};

/** Drops both sides of a scan once its result is in hand. */
const releaseScan = (scanId) => {
  if (!scanId) return;
  for (const side of ['front', 'back']) entries.delete(keyFor(scanId, side));
};

module.exports = { warmPreprocess, takePreprocessed, releaseScan };

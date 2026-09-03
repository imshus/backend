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
 *  - takePreprocessed is single-use (the entry is deleted on take).
 *  - Any warm failure deletes the entry; analyze falls back to on-demand
 *    preparation from the file on disk — identical output either way.
 */

const MAX_ENTRY_AGE_MS = 30 * 60 * 1000;

/** @type {Map<string, { promise: Promise<object>, filePath: string, createdAt: number }>} */
const entries = new Map();

const keyFor = (scanId, side) => `${scanId}:${side}`;

const pruneStale = () => {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (now - entry.createdAt > MAX_ENTRY_AGE_MS) {
      entries.delete(key);
    }
  }
};

const warmPreprocess = (scanId, side, filePath) => {
  if (!scanId || !side || !filePath) return;
  pruneStale();

  const key = keyFor(scanId, side);
  const promise = prepareImageViews(filePath);
  entries.set(key, { promise, filePath, createdAt: Date.now() });

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

const takePreprocessed = (scanId, side, filePath) => {
  if (!scanId || !side || !filePath) return null;
  pruneStale();

  const key = keyFor(scanId, side);
  const entry = entries.get(key);
  if (!entry) return null;

  // Single-use semantics: the entry is consumed (or discarded) either way.
  entries.delete(key);

  if (entry.filePath !== filePath) {
    // Stale entry for a superseded upload — never reuse; analyze goes on-demand.
    return null;
  }
  return entry.promise;
};

module.exports = { warmPreprocess, takePreprocessed };

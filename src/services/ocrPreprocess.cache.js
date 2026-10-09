const { prepareImageViews } = require('./ocrViews');
const { isAbortError } = require('../utils/abort');

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
 *  - A committed warm REPLACES any existing entry for the key, so a re-upload
 *    of the same side always supersedes the old result.
 *  - A warm begun before the upload's access check (beginWarm) is invisible
 *    until committed; a discarded one is aborted and never published.
 *  - Reading an entry does not consume it: a speculative analysis and the
 *    real one both need the same views, and making the first reader destroy
 *    them put a full decode back on the second one's critical path.
 *  - Any warm failure deletes the entry; analyze falls back to on-demand
 *    preparation from the file on disk — identical output either way.
 *  - Warming is also where a tag photographed upside down is turned upright,
 *    which is one small model call: it belongs here, off the /analyze critical
 *    path, rather than in front of the reads.
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

const NOOP_WARM = Object.freeze({ commit() {}, discard() {} });

/**
 * Starts preparing an upload's views before the caller has confirmed the
 * upload may be attached to the scan, so the decode and the orientation call
 * overlap the scan-record round trips instead of following them.
 *
 * Nothing is visible to takePreprocessed until commit(): an upload that fails
 * its access check is discard()ed, which aborts the work (the orientation
 * call included) and drops the result unseen. It never replaces the entry a
 * legitimate upload of the same scan holds, and never reaches any other scan.
 */
const beginWarm = (scanId, side, filePath, scanContext) => {
  if (!scanId || !side || !filePath) return NOOP_WARM;

  const key = keyFor(scanId, side);
  const controller = new AbortController();
  // Required here, not at the top: the reader service is what asks the model
  // which way up the tag is, and requiring it while this module is still
  // loading would be a cycle through ocrViews.
  const { detectPrintRotation } = require('./openai.service');
  const promise = prepareImageViews(filePath, {
    detectRotation: detectPrintRotation,
    scanContext,
    signal: controller.signal,
  });
  let state = 'pending';
  let failure = null;

  // Reported only once the upload is known to be the caller's: a warm that
  // is discarded was cancelled on purpose and failed nothing.
  const reportFailure = () => {
    console.error('[OCR_PREPROCESS_WARM_FAILED]', {
      scanId,
      side,
      error: failure?.message || String(failure),
    });
    const current = entries.get(key);
    if (current && current.promise === promise) {
      entries.delete(key);
    }
  };

  promise.catch((error) => {
    if (state === 'discarded' || isAbortError(error)) return;
    failure = error;
    if (state === 'committed') reportFailure();
  });

  return {
    commit() {
      if (state !== 'pending') return;
      state = 'committed';
      // Already failed: nothing to publish, analyze prepares on demand. The
      // entry of the upload this one replaces is stale either way.
      if (failure) {
        entries.delete(key);
        reportFailure();
        return;
      }
      entries.delete(key);
      entries.set(key, { promise, filePath, createdAt: Date.now() });
      pruneStale();
    },
    discard() {
      if (state !== 'pending') return;
      state = 'discarded';
      controller.abort();
    },
  };
};

const warmPreprocess = (scanId, side, filePath, scanContext) => {
  beginWarm(scanId, side, filePath, scanContext).commit();
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

module.exports = { beginWarm, warmPreprocess, takePreprocessed, releaseScan };

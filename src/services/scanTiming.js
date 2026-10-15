/**
 * How long scans take after Calculate, against the owner's target (~4 s).
 *
 * One [SCAN_TIMING] line per analyzed scan, JSON, with where the wait went
 * and nothing about the shop or the tag (no PII):
 *   scanId, totalMs (the /analyze request, received to answered),
 *   headStartMs (how long the speculative read had been running when
 *   Calculate came; 0 when none was used), rotationMs (the which-way-up
 *   probe), readMs, adjudicationMs (the third look), pricingMs, storeMs (the
 *   scan record's reads and writes), reads, images, tier, model,
 *   speculativeUsed.
 *
 * The last WINDOW totals are kept in memory for GET /api/v1/health
 * (scanTiming: count, p50Ms, p95Ms, maxMs, overTargetPct), which APItracker
 * reads. SCAN_TARGET_MS sets the target (default 4000).
 */

const WINDOW = 200;
const totals = [];

const targetMs = () => {
  const n = Number(process.env.SCAN_TARGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 4000;
};

const whole = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : null);

/** Logs one analyzed scan's timing line and adds it to the window. */
const recordScanTiming = (timing) => {
  const line = {
    scanId: String(timing.scanId || ''),
    totalMs: whole(timing.totalMs),
    headStartMs: whole(timing.headStartMs) ?? 0,
    rotationMs: whole(timing.rotationMs),
    readMs: whole(timing.readMs),
    adjudicationMs: whole(timing.adjudicationMs),
    pricingMs: whole(timing.pricingMs),
    storeMs: whole(timing.storeMs),
    reads: Number.isFinite(timing.reads) ? timing.reads : null,
    images: Number.isFinite(timing.images) ? timing.images : null,
    tier: timing.tier || null,
    model: timing.model || null,
    speculativeUsed: Boolean(timing.speculativeUsed),
  };
  console.info('[SCAN_TIMING]', JSON.stringify(line));
  if (line.totalMs !== null) {
    totals.push(line.totalMs);
    if (totals.length > WINDOW) totals.splice(0, totals.length - WINDOW);
  }
  return line;
};

/** Nearest-rank percentile of an ascending list. */
const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];

/** The window as /api/v1/health reports it; nulls until a scan is timed. */
const scanTimingSummary = () => {
  const target = targetMs();
  if (!totals.length) {
    return { count: 0, p50Ms: null, p95Ms: null, maxMs: null, overTargetPct: null, targetMs: target };
  }
  const sorted = [...totals].sort((a, b) => a - b);
  const over = sorted.filter((ms) => ms > target).length;
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1],
    overTargetPct: Math.round((over / sorted.length) * 1000) / 10,
    targetMs: target,
  };
};

module.exports = {
  recordScanTiming,
  scanTimingSummary,
  WINDOW,
  __internal: { reset: () => totals.splice(0) },
};

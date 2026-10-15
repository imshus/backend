const { spawn } = require('child_process');
const path = require('path');
const { computePricing: computePricingJs } = require('./pricingMath');

/**
 * The bridge to the Python pricing worker (calc/calc_worker.py): one
 * long-lived child process, spoken to in newline-delimited JSON, that runs
 * pricingMath's arithmetic in numpy and pandas.
 *
 * Pricing never fails or waits because of Python. Whenever the worker is
 * not ready, is restarting, answers late, answers wrong or not at all, the
 * request is priced in Node by pricingMath instead, the same figures to the
 * last bit, and each kind of failure is logged once.
 *
 *   CALC_ENGINE         'python' (default) | 'js', which never starts the worker
 *   CALC_ENGINE_SHADOW  true: run both, return the selected engine's result
 *                       and log any figure on which they differ
 *   PYTHON_BIN          the interpreter, default python3 (python on Windows)
 */

const WORKER_PATH = path.join(__dirname, '..', '..', 'calc', 'calc_worker.py');
const REQUEST_TIMEOUT_MS = 1500;
// The worker's first answer waits on Python loading numpy and pandas, a
// second or two on a small instance. Silent this long, it is restarted.
const STARTUP_TIMEOUT_MS = 30000;
const RESTART_BACKOFF_MS = [250, 1000, 5000, 15000, 60000];
// A worker that ran this long before dying restarts from the shortest delay.
const STABLE_AFTER_MS = 60000;
const MAX_LINE_CHARS = 4 * 1024 * 1024;

// Only what Python needs to start and find its packages: the server's own
// secrets stay out of the child's environment.
const ENV_PASSTHROUGH = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|LC_CTYPE|PYTHONPATH|PYTHONHOME|PYTHONUSERBASE|VIRTUAL_ENV|CONDA_PREFIX|LD_LIBRARY_PATH)$/i;

const NUMBER_INPUTS = [
  'netWt', 'grossWt', 'karatPurityPercent', 'karatNumber', 'goldRatePer10g',
  'labourRatePerUnit', 'wastagePercent', 'otherCharges',
];
const STRING_INPUTS = ['labourUnit', 'labourWeightBasis', 'labourChargeType', 'wastageCode'];

// The breakdown as the app reads it, in today's key order.
const BREAKDOWN_KEYS = [
  'diamondAmount', 'colorstoneAmount', 'pureWeight', 'goldRateApplied', 'goldAmount',
  'labourAmount', 'labourChargeType', 'wastageCode', 'wastagePercent', 'wastageWeightGrams',
  'wastageAmount', 'otherCharges', 'subtotal',
];
const BREAKDOWN_STRINGS = new Set(['labourChargeType', 'wastageCode']);
const DIAMOND_ITEM_KEYS = ['index', 'weight', 'rate', 'discountPercent', 'amount'];
const COLORSTONE_ITEM_KEYS = ['index', 'weight', 'rate', 'amount'];

// The price the worker must get exactly right before it is trusted: 18K,
// both stone kinds with a discount, labour per 10 g on gross, wastage.
const PROBE_INPUTS = {
  netWt: 12.345,
  grossWt: 13.871,
  customPurityPercent: null,
  karatPurityPercent: 75,
  karatNumber: 18,
  goldRatePer10g: 152340.5,
  diamonds: [
    { weight: 0.235, rate: 65000, discountPercent: 12.5 },
    { weight: 0.018, rate: 48000, discountPercent: 0 },
  ],
  colorstones: [{ weight: 1.27, rate: 3500 }],
  labourRatePerUnit: 1450,
  labourUnit: 'Per 10 Gram',
  labourWeightBasis: 'gross',
  wastagePercent: 8.5,
  otherCharges: 250,
  labourChargeType: 'AMOUNT_GLOBAL',
  wastageCode: 'W8',
};

const defaultPythonBin = () => (process.platform === 'win32' ? 'python' : 'python3');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A number JSON carries exactly both ways: finite, and not -0 (which JSON writes as 0). */
const isWireNumber = (value) => typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);

const rowsAreWireSafe = (rows, keys) =>
  Array.isArray(rows) && rows.every((row) => isPlainObject(row) && keys.every((key) => isWireNumber(row[key])));

/** Whether the worker can price these inputs to the bit; anything else stays in Node. */
function isWireSafe(inputs) {
  if (!isPlainObject(inputs)) return false;
  if (!NUMBER_INPUTS.every((key) => isWireNumber(inputs[key]))) return false;
  if (inputs.customPurityPercent !== null && !isWireNumber(inputs.customPurityPercent)) return false;
  if (!STRING_INPUTS.every((key) => typeof inputs[key] === 'string')) return false;
  return rowsAreWireSafe(inputs.diamonds, ['weight', 'rate', 'discountPercent'])
    && rowsAreWireSafe(inputs.colorstones, ['weight', 'rate']);
}

function readItems(raw, expectedLength, keys) {
  if (!Array.isArray(raw) || raw.length !== expectedLength) return null;
  const items = [];
  for (const item of raw) {
    if (!isPlainObject(item)) return null;
    const copy = {};
    for (const key of keys) {
      if (typeof item[key] !== 'number') return null;
      copy[key] = item[key];
    }
    items.push(copy);
  }
  return items;
}

/**
 * A worker reply as computePricing's result, rebuilt key by key in today's
 * order, or null when anything is missing or of the wrong type.
 */
function readResult(raw, inputs) {
  if (!isPlainObject(raw) || !isPlainObject(raw.breakdown)) return null;
  const breakdown = {};
  for (const key of BREAKDOWN_KEYS) {
    const value = raw.breakdown[key];
    if (typeof value !== (BREAKDOWN_STRINGS.has(key) ? 'string' : 'number')) return null;
    breakdown[key] = value;
  }
  const { finalMRP, effectivePurityPercent, purityAdjustedGoldRatePerGram } = raw;
  if (![finalMRP, effectivePurityPercent, purityAdjustedGoldRatePerGram].every((v) => typeof v === 'number')) {
    return null;
  }
  const diamondLineItems = readItems(raw.diamondLineItems, inputs.diamonds.length, DIAMOND_ITEM_KEYS);
  const colorstoneLineItems = readItems(raw.colorstoneLineItems, inputs.colorstones.length, COLORSTONE_ITEM_KEYS);
  if (!diamondLineItems || !colorstoneLineItems) return null;
  return {
    breakdown,
    finalMRP,
    effectivePurityPercent,
    purityAdjustedGoldRatePerGram,
    diamondLineItems,
    colorstoneLineItems,
  };
}

/**
 * The first place two results differ, as a path, or null when they are
 * identical: numbers by Object.is (so -0 and 0 differ), keys in order.
 */
function firstDifference(a, b, at = '') {
  if (typeof a === 'number' || typeof b === 'number') {
    return Object.is(a, b) ? null : `${at || '(root)'}: ${a} vs ${b}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${at}: length`;
    for (let i = 0; i < a.length; i += 1) {
      const diff = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.join() !== keysB.join()) return `${at || '(root)'}: keys ${keysA.join()} vs ${keysB.join()}`;
    for (const key of keysA) {
      const diff = firstDifference(a[key], b[key], at ? `${at}.${key}` : key);
      if (diff) return diff;
    }
    return null;
  }
  return a === b ? null : `${at || '(root)'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

function workerEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_PASSTHROUGH.test(key)) env[key] = value;
  }
  return {
    ...env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  };
}

// Every live worker, so none outlives the server.
const liveChildren = new Set();
process.once('exit', () => {
  for (const child of liveChildren) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
});

function createPyCalcEngine({
  engine = 'python',
  shadow = false,
  pythonBin = defaultPythonBin(),
  workerPath = WORKER_PATH,
  workerArgs = [],
  timeoutMs = REQUEST_TIMEOUT_MS,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  backoffMs = RESTART_BACKOFF_MS,
  logger = console,
} = {}) {
  const usesWorker = engine === 'python' || Boolean(shadow);
  const state = {
    worker: null,
    nextId: 1,
    failures: 0,
    restartTimer: null,
    stopped: false,
    disabled: null,
    warned: new Set(),
    waiters: [],
  };
  const counts = {
    python: 0,
    js: 0,
    fallback: {},
    spawns: 0,
    restarts: 0,
    shadowCompared: 0,
    shadowMismatches: 0,
  };

  function warnOnce(kind, message) {
    if (state.warned.has(kind)) return;
    state.warned.add(kind);
    logger.warn(`[CALC_ENGINE] ${message} (logged once per kind: ${kind})`);
  }

  function settleWaiters(ready) {
    const waiters = state.waiters;
    state.waiters = [];
    for (const resolve of waiters) resolve(ready);
  }

  function settle(worker, entry, outcome) {
    if (!worker.pending.has(entry.id)) return;
    worker.pending.delete(entry.id);
    clearTimeout(entry.timer);
    entry.done(outcome);
  }

  /** `reason` is the failure kind its outstanding requests fall back under. */
  function killWorker(worker, reason) {
    if (!worker.killReason) worker.killReason = reason;
    try {
      worker.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  function scheduleRestart() {
    if (state.restartTimer || state.stopped || state.disabled) return;
    const delay = backoffMs[Math.min(state.failures, backoffMs.length - 1)];
    state.failures += 1;
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (state.stopped || state.disabled || state.worker) return;
      counts.restarts += 1;
      spawnWorker();
    }, delay);
    state.restartTimer.unref?.();
  }

  function workerGone(worker, kind, detail) {
    if (worker.gone) return;
    worker.gone = true;
    liveChildren.delete(worker.child);
    if (state.worker === worker) state.worker = null;
    if (worker.readyAt && Date.now() - worker.readyAt > STABLE_AFTER_MS) state.failures = 0;
    for (const entry of [...worker.pending.values()]) {
      settle(worker, entry, { kind, detail });
    }
    settleWaiters(false);
    if (state.stopped || state.disabled) return;
    const tail = worker.stderrTail.length ? `; last stderr: ${worker.stderrTail.join(' | ')}` : '';
    warnOnce(kind, `python worker ${detail}${tail}; pricing in Node until it is back`);
    scheduleRestart();
  }

  function handleLine(worker, line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      message = undefined;
    }
    const hasId = isPlainObject(message) && message.id !== null && message.id !== undefined;
    const entry = hasId ? worker.pending.get(message.id) : undefined;
    if (!entry) {
      // A late answer to a request already priced in Node is dropped. A line
      // that names no request is the oldest one's answer: the worker answers
      // in order, one at a time.
      if (hasId) return;
      const oldest = worker.pending.values().next().value;
      if (oldest) {
        settle(worker, oldest, { kind: 'malformed', detail: `unreadable reply ${JSON.stringify(line.slice(0, 120))}` });
      }
      return;
    }
    if (message.ok === true) {
      const result = readResult(message.breakdown, entry.inputs);
      settle(worker, entry, result
        ? { result }
        : { kind: 'malformed', detail: 'a reply without a complete breakdown' });
    } else {
      settle(worker, entry, { kind: 'worker-error', detail: `worker error: ${String(message.error || '').slice(0, 300)}` });
    }
  }

  function onStdout(worker, chunk) {
    worker.stdoutBuffer += chunk;
    let newline = worker.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = worker.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      worker.stdoutBuffer = worker.stdoutBuffer.slice(newline + 1);
      handleLine(worker, line);
      newline = worker.stdoutBuffer.indexOf('\n');
    }
    if (worker.stdoutBuffer.length > MAX_LINE_CHARS) {
      worker.stdoutBuffer = '';
      const oldest = worker.pending.values().next().value;
      if (oldest) settle(worker, oldest, { kind: 'malformed', detail: 'a reply line past 4 MB' });
      killWorker(worker, 'malformed');
    }
  }

  function onStderr(worker, chunk) {
    worker.stderrBuffer += chunk;
    const lines = worker.stderrBuffer.split('\n');
    worker.stderrBuffer = lines.pop().slice(-MAX_LINE_CHARS);
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      worker.stderrTail.push(line.slice(0, 300));
      if (worker.stderrTail.length > 5) worker.stderrTail.shift();
      logger.info(`[CALC_WORKER] ${line}`);
    }
  }

  /** Writes one request; `done` gets { result } or { kind, detail }, once. */
  function send(worker, inputs, waitMs, done, { unrefTimer = false } = {}) {
    const id = state.nextId;
    state.nextId += 1;
    const entry = { id, inputs, done, timer: null };
    worker.pending.set(id, entry);
    entry.timer = setTimeout(() => {
      // A reply already sitting in the pipe is read before this decides.
      setImmediate(() => {
        if (!worker.pending.has(id)) return;
        settle(worker, entry, { kind: 'timeout', detail: `no answer within ${waitMs} ms` });
        // Late or hung, it is restarted; the requests behind it go to Node.
        killWorker(worker, 'timeout');
      });
    }, waitMs);
    if (unrefTimer) entry.timer.unref?.();
    try {
      worker.child.stdin.write(`${JSON.stringify({ id, inputs })}\n`);
    } catch (error) {
      settle(worker, entry, { kind: 'crash', detail: `write failed: ${error.message}` });
    }
  }

  function spawnWorker() {
    let child;
    try {
      child = spawn(pythonBin, [workerPath, ...workerArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: workerEnv(),
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      warnOnce('unavailable', `python worker could not start (${pythonBin}): ${error.message}; pricing in Node`);
      scheduleRestart();
      return null;
    }
    counts.spawns += 1;
    const worker = {
      child,
      ready: false,
      readyAt: 0,
      startedAt: Date.now(),
      gone: false,
      pending: new Map(),
      stdoutBuffer: '',
      stderrBuffer: '',
      stderrTail: [],
    };
    state.worker = worker;
    liveChildren.add(child);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => onStdout(worker, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => onStderr(worker, chunk));
    // A write to a worker that just died; its close event settles everything.
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      workerGone(worker, worker.ready ? 'crash' : 'unavailable',
        error.code === 'ENOENT' ? `${pythonBin} was not found` : `could not run: ${error.message}`);
    });
    child.on('close', (code, signal) => {
      const exit = `exit ${code}${signal ? `, ${signal}` : ''}`;
      if (worker.killReason) {
        workerGone(worker, worker.killReason, `stopped by the bridge (${worker.killReason}; ${exit})`);
      } else {
        workerGone(worker, worker.ready ? 'crash' : 'unavailable',
          `${worker.ready ? 'stopped' : 'stopped before it was ready'} (${exit})`);
      }
    });
    // An idle worker never holds the server open; a request waiting on it
    // does, through its timer.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref?.();

    // Trusted only once it has priced the probe exactly as Node does.
    send(worker, PROBE_INPUTS, startupTimeoutMs, (outcome) => {
      if (worker.gone) return;
      if (!outcome.result) {
        warnOnce(`startup-${outcome.kind}`, `python worker failed its first price (${outcome.detail}); restarting it`);
        killWorker(worker, 'unavailable');
        return;
      }
      const diff = firstDifference(outcome.result, computePricingJs(PROBE_INPUTS));
      if (diff) {
        state.disabled = `its first price differed from Node's at ${diff}`;
        warnOnce('disabled', `python worker turned off for this process: ${state.disabled}; pricing in Node`);
        killWorker(worker, 'disabled');
        settleWaiters(false);
        return;
      }
      worker.ready = true;
      worker.readyAt = Date.now();
      logger.info(`[CALC_ENGINE] python worker ready (pid ${child.pid}, ${worker.readyAt - worker.startedAt} ms)`);
      settleWaiters(true);
    }, { unrefTimer: true });
    return worker;
  }

  /** The worker when it can take a request now; starts it when there is none. */
  function readyWorker() {
    if (!usesWorker || state.stopped || state.disabled) return null;
    if (!state.worker && !state.restartTimer) spawnWorker();
    return state.worker && state.worker.ready ? state.worker : null;
  }

  /** { result } from Python, or { kind, detail } saying why not. Never rejects. */
  function viaWorker(inputs) {
    if (!isWireSafe(inputs)) {
      return Promise.resolve({ kind: 'unsupported-input', detail: 'an input JSON cannot carry exactly (non-finite, -0 or not a number)' });
    }
    const worker = readyWorker();
    if (!worker) {
      if (state.disabled) return Promise.resolve({ kind: 'disabled', detail: state.disabled });
      if (!usesWorker) return Promise.resolve({ kind: 'off', detail: 'CALC_ENGINE=js' });
      return Promise.resolve({ kind: 'starting', detail: 'the worker is starting or restarting' });
    }
    return new Promise((resolve) => {
      send(worker, inputs, timeoutMs, (outcome) => {
        if (outcome.result) state.failures = 0;
        resolve(outcome);
      });
    });
  }

  function noteFallback(outcome) {
    counts.fallback[outcome.kind] = (counts.fallback[outcome.kind] || 0) + 1;
    // Starting is expected after a deploy and after a restart: not a warning.
    if (outcome.kind !== 'starting') {
      warnOnce(outcome.kind, `priced in Node: ${outcome.detail}`);
    }
  }

  /** Logs and counts a difference; true when the two are identical. */
  function compareShadow(inputs, pythonResult, jsResult) {
    counts.shadowCompared += 1;
    const diff = firstDifference(pythonResult, jsResult);
    if (!diff) return true;
    counts.shadowMismatches += 1;
    logger.warn('[CALC_SHADOW] python and node differ', JSON.stringify({ at: diff, inputs }));
    return false;
  }

  /**
   * computePricing's result and where it came from: source 'python', 'js'
   * (CALC_ENGINE=js) or 'fallback' (with the kind of failure).
   */
  async function computePricingDetailed(inputs) {
    if (engine !== 'python') {
      const result = computePricingJs(inputs);
      counts.js += 1;
      if (shadow) {
        viaWorker(inputs).then((outcome) => {
          if (outcome.result) compareShadow(inputs, outcome.result, result);
        });
      }
      return { result, source: 'js' };
    }
    const outcome = await viaWorker(inputs);
    if (outcome.result) {
      if (shadow) {
        // Node's figures are the reference: on a difference the price is Node's.
        const jsResult = computePricingJs(inputs);
        if (!compareShadow(inputs, outcome.result, jsResult)) {
          counts.fallback['shadow-mismatch'] = (counts.fallback['shadow-mismatch'] || 0) + 1;
          return { result: jsResult, source: 'fallback', kind: 'shadow-mismatch' };
        }
      }
      counts.python += 1;
      return { result: outcome.result, source: 'python' };
    }
    noteFallback(outcome);
    return { result: computePricingJs(inputs), source: 'fallback', kind: outcome.kind };
  }

  async function computePricing(inputs) {
    return (await computePricingDetailed(inputs)).result;
  }

  /**
   * Starts the worker if it is not running and resolves true once it is
   * ready, false when it cannot be (CALC_ENGINE=js, Python missing, a failed
   * start) or after `waitMs`.
   */
  function warm({ waitMs = startupTimeoutMs } = {}) {
    if (readyWorker()) return Promise.resolve(true);
    if (!usesWorker || state.stopped || state.disabled) return Promise.resolve(false);
    return new Promise((resolve) => {
      // Holds the process open while someone waits on the worker.
      const timer = setTimeout(() => {
        state.waiters = state.waiters.filter((waiter) => waiter !== finish);
        resolve(false);
      }, waitMs);
      function finish(ready) {
        clearTimeout(timer);
        resolve(ready);
      }
      state.waiters.push(finish);
    });
  }

  /** Stops the worker for good (tests, shutdown); later requests price in Node. */
  function stop() {
    state.stopped = true;
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
    const worker = state.worker;
    if (worker) {
      for (const entry of [...worker.pending.values()]) {
        settle(worker, entry, { kind: 'stopped', detail: 'the engine was stopped' });
      }
      killWorker(worker, 'stopped');
    }
    settleWaiters(false);
  }

  function stats() {
    return {
      ...counts,
      fallback: { ...counts.fallback },
      workerPid: state.worker?.child?.pid ?? null,
      workerReady: Boolean(state.worker?.ready),
      disabled: state.disabled,
    };
  }

  function describe() {
    const bits = [`engine=${engine}`];
    if (usesWorker) bits.push(`python=${pythonBin}`, `timeout=${timeoutMs}ms`);
    bits.push(`shadow=${shadow ? 'on' : 'off'}`);
    if (!usesWorker) bits.push('(pricing in Node; the Python worker is not started)');
    return bits.join(' ');
  }

  return {
    computePricing,
    computePricingDetailed,
    warm,
    stop,
    stats,
    describe,
    /** The live worker process, for tests. */
    workerProcess: () => state.worker?.child ?? null,
  };
}

// ── The server's engine, configured from the environment ────────────────

let defaultEngine = null;

function getDefaultEngine() {
  if (!defaultEngine) {
    const config = require('../config/env');
    defaultEngine = createPyCalcEngine({
      engine: config.calc.engine,
      shadow: config.calc.shadow,
      pythonBin: config.calc.pythonBin || defaultPythonBin(),
    });
  }
  return defaultEngine;
}

/** Replaces the server's engine (tests and benchmarks); returns the previous one. */
function setDefaultEngine(engine) {
  const previous = defaultEngine;
  defaultEngine = engine;
  return previous;
}

/**
 * The startup log line (grep CALC_ENGINE), and with the Python engine the
 * worker started now, so the first scan does not wait on numpy loading.
 */
function announce(logger = console) {
  const engine = getDefaultEngine();
  logger.info(`[CALC_ENGINE] ${engine.describe()}`);
  engine.warm().then((ready) => {
    if (!ready && engine.describe().startsWith('engine=python')) {
      logger.warn('[CALC_ENGINE] python worker not ready; pricing in Node until it is');
    }
  });
}

module.exports = {
  createPyCalcEngine,
  computePricing: (inputs) => getDefaultEngine().computePricing(inputs),
  getDefaultEngine,
  setDefaultEngine,
  announce,
  isWireSafe,
  firstDifference,
  PROBE_INPUTS,
  WORKER_PATH,
};

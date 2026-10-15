const { spawn } = require('child_process');
const path = require('path');
const { computePricing: computePricingJs } = require('./pricingMath');

/**
 * The bridge to the Python pricing worker (calc/calc_worker.py): one
 * long-lived child process, spoken to in newline-delimited JSON, that runs
 * pricingMath's arithmetic in numpy and pandas.
 *
 * Pricing never fails or waits because of Python. Whenever the worker is
 * not ready, is restarting, is too far behind, answers late, answers wrong
 * or not at all, or the request is too big to send (see MAX_WIRE_ROWS), the
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

// One worker serves every request in turn, so no single request may tie it
// up. A tag has a few dozen stone rows at most; a price past either limit is
// worked out in Node and never sent (500 rows take Python about 2 ms).
const MAX_WIRE_ROWS = 500;
const MAX_REQUEST_CHARS = 128 * 1024;
// Requests written to the worker and not yet answered, including those
// already priced in Node after a timeout. Past this, prices go to Node at
// once instead of queueing towards the timeout.
const MAX_OUTSTANDING = 256;
// A reply line longer than this costs its own request alone: the rest of the
// line is skipped and that price is worked out in Node.
const MAX_REPLY_CHARS = 1024 * 1024;
const MAX_STDERR_PARTIAL_CHARS = 64 * 1024;
const MAX_LOGGED_LINE_CHARS = 2000;
// Stderr of a worker that is still starting, kept back until it is ready or
// has failed (see reportStartupStderr).
const MAX_STARTUP_STDERR_LINES = 40;

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

const UNSUPPORTED = {
  kind: 'unsupported-input',
  detail: 'an input JSON cannot carry exactly (non-finite, -0 or not a number)',
};

/**
 * Why these inputs stay in Node, as { kind, detail }, or null when the
 * worker can price them to the bit. The row count is checked first, so a
 * huge stone list costs no more than its length to turn away.
 */
function wireProblem(inputs) {
  if (!isPlainObject(inputs)) return UNSUPPORTED;
  const { diamonds, colorstones } = inputs;
  if (Array.isArray(diamonds) && Array.isArray(colorstones)) {
    const rows = diamonds.length + colorstones.length;
    if (rows > MAX_WIRE_ROWS) {
      return { kind: 'oversized', detail: `${rows} stone rows, more than the ${MAX_WIRE_ROWS} sent to Python` };
    }
  }
  if (!NUMBER_INPUTS.every((key) => isWireNumber(inputs[key]))) return UNSUPPORTED;
  if (inputs.customPurityPercent !== null && !isWireNumber(inputs.customPurityPercent)) return UNSUPPORTED;
  if (!STRING_INPUTS.every((key) => typeof inputs[key] === 'string')) return UNSUPPORTED;
  const rowsSafe = rowsAreWireSafe(diamonds, ['weight', 'rate', 'discountPercent'])
    && rowsAreWireSafe(colorstones, ['weight', 'rate']);
  return rowsSafe ? null : UNSUPPORTED;
}

/** Whether the worker may price these inputs; anything else stays in Node. */
const isWireSafe = (inputs) => wireProblem(inputs) === null;

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
  maxRequestChars = MAX_REQUEST_CHARS,
  maxReplyChars = MAX_REPLY_CHARS,
  maxOutstanding = MAX_OUTSTANDING,
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
    // The last failed start's stderr, digits blanked out so that a pid in it
    // does not make every attempt look like a new failure.
    lastStartupStderr: null,
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

  const logWorkerLine = (line) => logger.info(`[CALC_WORKER] ${line.slice(0, MAX_LOGGED_LINE_CHARS)}`);

  /**
   * A worker that failed to start has its stderr logged the first time it
   * fails that way. The same failure on each retry (numpy not installed is
   * the same traceback every minute) is not logged again.
   */
  function reportStartupStderr(worker) {
    const lines = worker.startupStderr;
    if (worker.stderrBuffer.trim()) lines.push(worker.stderrBuffer.replace(/\r$/, ''));
    worker.stderrBuffer = '';
    if (!lines.length || state.stopped) return;
    const signature = lines.join('\n').replace(/\d+/g, '#');
    if (signature === state.lastStartupStderr) return;
    state.lastStartupStderr = signature;
    for (const line of lines) logWorkerLine(line);
    if (worker.startupStderrDropped) logWorkerLine(`(${worker.startupStderrDropped} more lines)`);
  }

  function workerGone(worker, kind, detail) {
    if (worker.gone) return;
    worker.gone = true;
    clearTimeout(worker.stallTimer);
    liveChildren.delete(worker.child);
    if (state.worker === worker) state.worker = null;
    if (worker.readyAt && Date.now() - worker.readyAt > STABLE_AFTER_MS) state.failures = 0;
    if (!worker.ready) reportStartupStderr(worker);
    for (const entry of [...worker.pending.values()]) {
      settle(worker, entry, { kind, detail });
    }
    settleWaiters(false);
    if (state.stopped || state.disabled) return;
    const tail = worker.stderrTail.length ? `; last stderr: ${worker.stderrTail.join(' | ')}` : '';
    warnOnce(kind, `python worker ${detail}${tail}; pricing in Node until it is back`);
    scheduleRestart();
  }

  /** A reply line arrived: the worker has moved on by one request. */
  function noteAnswered(worker) {
    worker.answered += 1;
    worker.lastAnswerAt = Date.now();
  }

  /**
   * Kept on a worker that has fallen behind: it is restarted only once it
   * has gone a whole timeout with requests outstanding and no reply at all.
   */
  function watchForStall(worker) {
    if (worker.stallTimer || worker.gone) return;
    const wait = Math.max(1, worker.lastAnswerAt + timeoutMs - Date.now());
    worker.stallTimer = setTimeout(() => {
      worker.stallTimer = null;
      if (worker.gone || worker.sent <= worker.answered) return;
      if (Date.now() - worker.lastAnswerAt >= timeoutMs) {
        killWorker(worker, 'timeout');
      } else {
        watchForStall(worker);
      }
    }, wait);
    worker.stallTimer.unref?.();
  }

  function handleLine(worker, line) {
    if (!line.trim()) return;
    noteAnswered(worker);
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
    const data = worker.stdoutBuffer + chunk;
    worker.stdoutBuffer = '';
    let start = 0;
    let newline = data.indexOf('\n');
    while (newline !== -1) {
      if (worker.skippingLongLine) {
        // The end of an over-long reply, already counted and priced in Node.
        worker.skippingLongLine = false;
      } else {
        handleLine(worker, data.slice(start, newline).replace(/\r$/, ''));
      }
      start = newline + 1;
      newline = data.indexOf('\n', start);
    }
    if (worker.skippingLongLine) return;
    const rest = data.slice(start);
    if (rest.length <= maxReplyChars) {
      worker.stdoutBuffer = rest;
      return;
    }
    // Replies come in order, so this one is the oldest request's: that price
    // goes to Node, the rest of the line is skipped, and the worker carries
    // on with the requests behind it.
    worker.skippingLongLine = true;
    noteAnswered(worker);
    const oldest = worker.pending.values().next().value;
    if (oldest) settle(worker, oldest, { kind: 'malformed', detail: `a reply line longer than ${maxReplyChars} characters` });
  }

  function onStderr(worker, chunk) {
    worker.stderrBuffer += chunk;
    const lines = worker.stderrBuffer.split('\n');
    worker.stderrBuffer = lines.pop().slice(-MAX_STDERR_PARTIAL_CHARS);
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      worker.stderrTail.push(line.slice(0, 300));
      if (worker.stderrTail.length > 5) worker.stderrTail.shift();
      if (worker.ready) {
        logWorkerLine(line);
      } else if (worker.startupStderr.length < MAX_STARTUP_STDERR_LINES) {
        // Logged once it is ready, or by reportStartupStderr if it fails.
        worker.startupStderr.push(line.slice(0, MAX_LOGGED_LINE_CHARS));
      } else {
        worker.startupStderrDropped += 1;
      }
    }
  }

  /** Writes one request; `done` gets { result } or { kind, detail }, once. */
  function send(worker, inputs, waitMs, done, { unrefTimer = false } = {}) {
    const id = state.nextId;
    state.nextId += 1;
    const line = `${JSON.stringify({ id, inputs })}\n`;
    if (line.length > maxRequestChars) {
      done({ kind: 'oversized', detail: `a request of ${line.length} characters, more than the ${maxRequestChars} sent to Python` });
      return;
    }
    const entry = { id, inputs, done, timer: null, answeredBefore: worker.answered };
    worker.pending.set(id, entry);
    entry.timer = setTimeout(() => {
      // A reply already sitting in the pipe is read before this decides.
      setImmediate(() => {
        if (!worker.pending.has(id)) return;
        settle(worker, entry, { kind: 'timeout', detail: `no answer within ${waitMs} ms` });
        if (worker.answered === entry.answeredBefore) {
          // Not one reply since this request was written: hung, so restarted.
          killWorker(worker, 'timeout');
        } else {
          // Still answering, only behind: kept, and watched.
          watchForStall(worker);
        }
      });
    }, waitMs);
    if (unrefTimer) entry.timer.unref?.();
    try {
      worker.child.stdin.write(line);
      worker.sent += 1;
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
      // Lines written and lines read back: the worker answers each request
      // with one line, in order, so the difference is its backlog.
      sent: 0,
      answered: 0,
      lastAnswerAt: Date.now(),
      stallTimer: null,
      stdoutBuffer: '',
      skippingLongLine: false,
      stderrBuffer: '',
      stderrTail: [],
      startupStderr: [],
      startupStderrDropped: 0,
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
      if (worker.gone || state.stopped) return;
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
      state.lastStartupStderr = null;
      for (const line of worker.startupStderr) logWorkerLine(line);
      worker.startupStderr = [];
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
    const problem = wireProblem(inputs);
    if (problem) return Promise.resolve(problem);
    const worker = readyWorker();
    if (!worker) {
      if (state.disabled) return Promise.resolve({ kind: 'disabled', detail: state.disabled });
      if (!usesWorker) return Promise.resolve({ kind: 'off', detail: 'CALC_ENGINE=js' });
      return Promise.resolve({ kind: 'starting', detail: 'the worker is starting or restarting' });
    }
    if (worker.sent - worker.answered >= maxOutstanding) {
      return Promise.resolve({ kind: 'busy', detail: `${maxOutstanding} requests already waiting on the worker` });
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
      workerBacklog: state.worker ? Math.max(0, state.worker.sent - state.worker.answered) : 0,
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

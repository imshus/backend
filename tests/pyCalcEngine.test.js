/**
 * The bridge to the Python pricing worker never lets Python fail or skew a
 * price: a worker that is killed mid-request, hangs, writes garbage, errors,
 * answers the wrong shape, crashes or is missing altogether gives way to
 * Node's pricingMath (the same figures), restarts with backoff, and one bad
 * request never spoils the others. With CALC_ENGINE=js no worker is started.
 *
 * Misbehaving workers are tests/fixtures/pycalc/fakeWorker.js run by node;
 * the tests that need the real calc_worker.py skip, saying so, without
 * python, numpy and pandas.
 */
process.env.USE_MEMORY_STORE = 'true';
// This file's own server engine is the Node one: the last test checks that
// computeMrp then never starts a worker.
process.env.CALC_ENGINE = 'js';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { computePricing } = require('../src/services/pricingMath');
const pyCalcEngine = require('../src/services/pyCalcEngine');

const { createPyCalcEngine, firstDifference, PROBE_INPUTS } = pyCalcEngine;
const FAKE_WORKER = path.join(__dirname, 'fixtures', 'pycalc', 'fakeWorker.js');
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const pythonCheck = spawnSync(PYTHON_BIN, ['-c', 'import numpy, pandas'], { encoding: 'utf8', windowsHide: true });
const skipPython = pythonCheck.status === 0
  ? false
  : `${PYTHON_BIN} with numpy and pandas not found; pip install -r calc/requirements.txt`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, what, ms = 15000) {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function capturingLogger() {
  const lines = { info: [], warn: [] };
  return {
    lines,
    info: (...args) => lines.info.push(args.join(' ')),
    warn: (...args) => lines.warn.push(args.join(' ')),
  };
}

/** A different price for each n, so a reply matched to the wrong request shows. */
function inputsFor(n) {
  return {
    ...PROBE_INPUTS,
    netWt: Number((1 + n * 0.731).toFixed(3)),
    otherCharges: n,
    diamonds: Array.from({ length: n % 7 }, (_, i) => ({ weight: 0.011 * (i + 1) + n / 1000, rate: 50000 + n, discountPercent: i * 5 })),
    colorstones: Array.from({ length: n % 5 }, (_, i) => ({ weight: 0.3 + i / 100, rate: 1200 + n })),
  };
}

function fakeEngine(mode, options = {}) {
  const logger = capturingLogger();
  const engine = createPyCalcEngine({
    engine: 'python',
    pythonBin: process.execPath,
    workerPath: FAKE_WORKER,
    workerArgs: [mode],
    timeoutMs: 300,
    startupTimeoutMs: 5000,
    backoffMs: [20, 40],
    logger,
    ...options,
  });
  return { engine, logger };
}

function assertNodeFigures(answer, inputs) {
  assert.equal(firstDifference(answer.result, computePricing(inputs)), null);
}

test('a fake worker that behaves is used once it has priced the probe', async () => {
  const { engine } = fakeEngine('ok');
  try {
    assert.equal(await engine.warm(), true);
    const answer = await engine.computePricingDetailed(inputsFor(3));
    assert.equal(answer.source, 'python');
    assertNodeFigures(answer, inputsFor(3));
  } finally {
    engine.stop();
  }
});

test('while the worker starts, prices go to Node at once instead of waiting for it', async () => {
  const { engine } = fakeEngine('slow-start');
  try {
    const started = Date.now();
    const answer = await engine.computePricingDetailed(inputsFor(1));
    assert.ok(Date.now() - started < 200, 'no wait on the worker starting');
    assert.equal(answer.source, 'fallback');
    assert.equal(answer.kind, 'starting');
    assertNodeFigures(answer, inputsFor(1));
    assert.equal(await engine.warm(), true);
    assert.equal((await engine.computePricingDetailed(inputsFor(2))).source, 'python');
  } finally {
    engine.stop();
  }
});

test('a worker that hangs: the request falls back after the timeout and the worker is restarted', async () => {
  const { engine, logger } = fakeEngine('hang');
  try {
    assert.equal(await engine.warm(), true);
    const started = Date.now();
    const answer = await engine.computePricingDetailed(inputsFor(4));
    const waited = Date.now() - started;
    assert.equal(answer.source, 'fallback');
    assert.equal(answer.kind, 'timeout');
    assert.ok(waited >= 290 && waited < 2000, `waited ${waited} ms`);
    assertNodeFigures(answer, inputsFor(4));
    await waitFor(() => engine.stats().restarts >= 1 && engine.stats().workerReady, 'the restart');
    assert.equal(engine.stats().spawns, 2);
    assert.equal(logger.lines.warn.filter((line) => line.includes('(logged once per kind: timeout)')).length, 1);
  } finally {
    engine.stop();
  }
});

test('a reply that is not JSON falls back, and the worker keeps serving', async () => {
  const { engine, logger } = fakeEngine('malformed');
  try {
    assert.equal(await engine.warm(), true);
    for (let n = 0; n < 3; n += 1) {
      const answer = await engine.computePricingDetailed(inputsFor(n));
      assert.equal(answer.source, 'fallback');
      assert.equal(answer.kind, 'malformed');
      assertNodeFigures(answer, inputsFor(n));
    }
    assert.equal(engine.stats().spawns, 1, 'no restart for a bad line');
    assert.equal(logger.lines.warn.length, 1, 'one warning for the kind, not one per request');
  } finally {
    engine.stop();
  }
});

test('an error reply or a reply without a full breakdown falls back', async () => {
  for (const [mode, kind] of [['error', 'worker-error'], ['shape', 'malformed']]) {
    const { engine } = fakeEngine(mode);
    try {
      assert.equal(await engine.warm(), true);
      const answer = await engine.computePricingDetailed(inputsFor(5));
      assert.equal(answer.source, 'fallback', mode);
      assert.equal(answer.kind, kind, mode);
      assertNodeFigures(answer, inputsFor(5));
    } finally {
      engine.stop();
    }
  }
});

test('stray lines on stdout cost a fallback, never a wrong price', async () => {
  const { engine } = fakeEngine('noise');
  try {
    assert.equal(await engine.warm(), true);
    const inputs = Array.from({ length: 20 }, (_, n) => inputsFor(n));
    const answers = await Promise.all(inputs.map((one) => engine.computePricingDetailed(one)));
    answers.forEach((answer, n) => assertNodeFigures(answer, inputs[n]));
  } finally {
    engine.stop();
  }
});

test('a worker that crashes on a request: that request falls back, the worker restarts', async () => {
  const { engine, logger } = fakeEngine('crash');
  try {
    assert.equal(await engine.warm(), true);
    const answer = await engine.computePricingDetailed(inputsFor(6));
    assert.equal(answer.source, 'fallback');
    assert.equal(answer.kind, 'crash');
    assertNodeFigures(answer, inputsFor(6));
    await waitFor(() => engine.stats().restarts >= 1 && engine.stats().workerReady, 'the restart');
    assert.ok(logger.lines.warn.some((line) => line.includes('exit 3')));
  } finally {
    engine.stop();
  }
});

test('python missing or failing to start: every price comes from Node, one warning, retried with backoff', async () => {
  const missing = capturingLogger();
  const noPython = createPyCalcEngine({ engine: 'python', pythonBin: 'no-such-python-for-mrpscan', backoffMs: [20], logger: missing });
  const { engine: exitsEarly, logger: early } = fakeEngine('exit-early');
  try {
    for (const [engine, logger, needle] of [[noPython, missing, 'was not found'], [exitsEarly, early, 'No module named']]) {
      for (let n = 0; n < 5; n += 1) {
        const answer = await engine.computePricingDetailed(inputsFor(n));
        assert.notEqual(answer.source, 'python');
        assertNodeFigures(answer, inputsFor(n));
        await sleep(30);
      }
      assert.equal(await engine.warm({ waitMs: 5000 }), false);
      await waitFor(() => engine.stats().spawns >= 2, 'a retry');
      const warnings = logger.lines.warn.filter((line) => line.includes('unavailable'));
      assert.equal(warnings.length, 1, warnings.join('\n'));
      assert.ok(warnings[0].includes(needle), warnings[0]);
    }
  } finally {
    noPython.stop();
    exitsEarly.stop();
  }
});

test('a worker whose first price differs from Node is turned off, not restarted', async () => {
  const { engine, logger } = fakeEngine('probe-wrong');
  try {
    assert.equal(await engine.warm(), false);
    const answer = await engine.computePricingDetailed(inputsFor(2));
    assert.equal(answer.source, 'fallback');
    assert.equal(answer.kind, 'disabled');
    assertNodeFigures(answer, inputsFor(2));
    await sleep(100);
    assert.equal(engine.stats().spawns, 1);
    assert.match(engine.stats().disabled, /finalMRP/);
    assert.ok(logger.lines.warn.some((line) => line.includes('turned off')));
  } finally {
    engine.stop();
  }
});

test('shadow mode logs a difference and prices with Node\'s figures', async () => {
  const { engine, logger } = fakeEngine('wrong', { shadow: true });
  try {
    assert.equal(await engine.warm(), true);
    const answer = await engine.computePricingDetailed(inputsFor(3));
    assert.equal(answer.kind, 'shadow-mismatch');
    assertNodeFigures(answer, inputsFor(3));
    assert.equal(engine.stats().shadowMismatches, 1);
    assert.ok(logger.lines.warn.some((line) => line.startsWith('[CALC_SHADOW]') && line.includes('finalMRP')));
  } finally {
    engine.stop();
  }

  // CALC_ENGINE=js with shadow: Node prices, Python is compared beside it.
  const jsShadow = fakeEngine('wrong', { engine: 'js', shadow: true });
  try {
    assert.equal(await jsShadow.engine.warm(), true);
    const answer = await jsShadow.engine.computePricingDetailed(inputsFor(4));
    assert.equal(answer.source, 'js');
    assertNodeFigures(answer, inputsFor(4));
    await waitFor(() => jsShadow.engine.stats().shadowMismatches === 1, 'the shadow comparison');
  } finally {
    jsShadow.engine.stop();
  }
});

test('CALC_ENGINE=js never starts a worker', async () => {
  const engine = createPyCalcEngine({ engine: 'js', pythonBin: 'must-never-run', logger: capturingLogger() });
  for (let n = 0; n < 50; n += 1) {
    const answer = await engine.computePricingDetailed(inputsFor(n));
    assert.equal(answer.source, 'js');
    assertNodeFigures(answer, inputsFor(n));
  }
  assert.equal(await engine.warm(), false);
  assert.equal(engine.stats().spawns, 0);
  assert.equal(engine.workerProcess(), null);
});

// ── The real worker ──────────────────────────────────────────────────────

test('real worker: 200 simultaneous requests each get their own answer', { skip: skipPython }, async () => {
  const engine = createPyCalcEngine({ engine: 'python', logger: capturingLogger() });
  try {
    assert.equal(await engine.warm(), true);
    const inputs = Array.from({ length: 200 }, (_, n) => inputsFor(n));
    const answers = await Promise.all(inputs.map((one) => engine.computePricingDetailed(one)));
    answers.forEach((answer, n) => {
      assert.equal(answer.source, 'python', `request ${n}: ${answer.kind}`);
      assertNodeFigures(answer, inputs[n]);
    });
    assert.equal(engine.stats().python, 200);
  } finally {
    engine.stop();
  }
});

test('real worker: one bad request among 200 does not spoil the others', { skip: skipPython }, async () => {
  const engine = createPyCalcEngine({ engine: 'python', logger: capturingLogger() });
  try {
    assert.equal(await engine.warm(), true);
    // Every tenth overflows a stone line to Infinity, which Python cannot
    // put in JSON: an error reply for that request alone.
    const inputs = Array.from({ length: 200 }, (_, n) => (n % 10 === 0
      ? { ...inputsFor(n), colorstones: [{ weight: 1e308, rate: 1e308 }] }
      : inputsFor(n)));
    const answers = await Promise.all(inputs.map((one) => engine.computePricingDetailed(one)));
    answers.forEach((answer, n) => {
      assert.equal(answer.source, n % 10 === 0 ? 'fallback' : 'python', `request ${n}`);
      assertNodeFigures(answer, inputs[n]);
    });
    assert.equal(engine.stats().fallback['worker-error'], 20);
    assert.equal(engine.stats().spawns, 1, 'the worker never went down');
  } finally {
    engine.stop();
  }
});

test('real worker: killed mid-request, the outstanding prices come from Node and it restarts', { skip: skipPython }, async () => {
  const engine = createPyCalcEngine({ engine: 'python', backoffMs: [50], logger: capturingLogger() });
  try {
    assert.equal(await engine.warm(), true);
    const firstPid = engine.workerProcess().pid;
    const inputs = Array.from({ length: 50 }, (_, n) => inputsFor(n));
    const pending = inputs.map((one) => engine.computePricingDetailed(one));
    engine.workerProcess().kill('SIGKILL');
    const answers = await Promise.all(pending);
    answers.forEach((answer, n) => assertNodeFigures(answer, inputs[n]));
    assert.ok(answers.some((answer) => answer.kind === 'crash'), 'at least one was cut off by the kill');

    await waitFor(() => engine.stats().workerReady, 'the restarted worker', 30000);
    assert.notEqual(engine.workerProcess().pid, firstPid);
    assert.equal(engine.stats().restarts, 1);
    const after = await engine.computePricingDetailed(inputsFor(77));
    assert.equal(after.source, 'python');
    assertNodeFigures(after, inputsFor(77));
  } finally {
    engine.stop();
  }
});

test('real worker: garbage on its stdin gets an error reply and it carries on', { skip: skipPython }, async () => {
  const engine = createPyCalcEngine({ engine: 'python', logger: capturingLogger() });
  try {
    assert.equal(await engine.warm(), true);
    const child = engine.workerProcess();
    child.stdin.write('not json at all\n{"id": NaN}\n[1,2,3]\n{"id": 999999, "inputs": {"netWt": "12"}}\n\n');
    // Its error replies name no pending request (or none at all) while
    // nothing is outstanding, so they are dropped; the worker is still there
    // and still right.
    await sleep(500);
    const answer = await engine.computePricingDetailed(inputsFor(8));
    assert.equal(answer.source, 'python');
    assertNodeFigures(answer, inputsFor(8));
    assert.equal(engine.workerProcess().pid, child.pid);
  } finally {
    engine.stop();
  }
});

// ── The server's engine ──────────────────────────────────────────────────

test('computeMrp with CALC_ENGINE=js prices in Node and never starts the worker', async (t) => {
  const calculationController = require('../src/controllers/calculation.controller');
  const rateCalculationService = require('../src/services/rateCalculation.service');
  const redisService = require('../src/services/redis.service');
  const LabourRate = require('../src/models/labourRate.model');
  const originals = [
    [rateCalculationService, 'getLiveGoldRates'], [redisService, 'getScan'],
    [redisService, 'updateScanStatus'], [LabourRate, 'findOne'],
  ].map(([owner, key]) => [owner, key, owner[key]]);
  const info = console.info;
  t.after(() => {
    console.info = info;
    for (const [owner, key, value] of originals) owner[key] = value;
  });
  rateCalculationService.getLiveGoldRates = async () => ({
    karatRates: [{ carat: '18Kt', purity: 75 }],
    taxSettings: { rtgsFinalRate: 80000, cashFinalRate: 90000 },
  });
  redisService.getScan = async () => ({ scanId: 'scan-1', ownerUserId: 'u1', businessId: 'b1', status: 'READY_FOR_REVIEW' });
  redisService.updateScanStatus = async () => ({});
  LabourRate.findOne = async () => ({ chargeType: 'AMOUNT', value: 100, rupeesUnit: 'Per Gram' });
  console.info = () => {};

  const res = { body: null, status() { return this; }, json(payload) { this.body = payload; return this; } };
  await calculationController.calculateMRP({
    params: { scanId: 'scan-1' },
    user: { userId: 'u1', businessId: 'b1', role: 'OWNER' },
    body: { netWt: 10, grossWt: 12, purityKarat: '18K', diamonds: [{ weight: 0.5, rate: 10000, discountPercent: 10 }], otherCharges: 300 },
  }, res, (error) => { throw error; });

  assert.equal(res.body.data.finalMRP, 60000 + 4500 + 1000 + 300);
  const server = pyCalcEngine.getDefaultEngine();
  assert.match(server.describe(), /^engine=js/);
  assert.equal(server.stats().js, 1);
  assert.equal(server.stats().spawns, 0);
  assert.equal(server.workerProcess(), null);
});

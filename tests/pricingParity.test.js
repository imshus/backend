/**
 * The Python pricing worker (calc/calc_worker.py) and Node's pricingMath give
 * IDENTICAL figures: every number of every result compared with Object.is
 * (so even 0 and -0 differ), on seeded random realistic prices and on edge
 * cases, and computeMrp's response is the same object whichever engine
 * priced it.
 *
 * pricingMath rounds twice, both with src/utils/money.js roundHalfUp (the
 * MRP to the rupee, an estimated net weight to the milligram), which the
 * worker reproduces with the same six-place snap; everything else is plain
 * IEEE double arithmetic, and identity is what is held here. The rates are
 * rounded in getLiveGoldRates, which stays in Node and reaches both engines
 * as the same number. One case in ten is an MRP of exactly x.50 on paper.
 *
 * Needs python with calc/requirements.txt; skipped, saying so, without it.
 */
process.env.USE_MEMORY_STORE = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const { computePricing } = require('../src/services/pricingMath');
const pyCalcEngine = require('../src/services/pyCalcEngine');
const { seeded, realisticInputs, tieInputs } = require('./fixtures/pycalc/realisticInputs');

const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const pythonCheck = spawnSync(PYTHON_BIN, ['-c', 'import numpy, pandas'], { encoding: 'utf8', windowsHide: true });
const skip = pythonCheck.status === 0
  ? false
  : `${PYTHON_BIN} with numpy and pandas not found; pip install -r calc/requirements.txt`;

const quietLogger = { info() {}, warn() {} };

const PARITY_CASES = 12000;
const BATCH = 200;

test('parity: 12,000 seeded realistic prices are identical in Python and Node, field by field', { skip }, async () => {
  const engine = pyCalcEngine.createPyCalcEngine({ engine: 'python', logger: quietLogger });
  try {
    assert.equal(await engine.warm(), true, 'the worker starts and prices the probe exactly');
    const rnd = seeded(20261015);
    let compared = 0;
    let numbersCompared = 0;
    const countNumbers = (value) => {
      if (typeof value === 'number') return 1;
      if (value && typeof value === 'object') return Object.values(value).reduce((n, v) => n + countNumbers(v), 0);
      return 0;
    };
    for (let start = 0; start < PARITY_CASES; start += BATCH) {
      const cases = Array.from({ length: BATCH }, () => realisticInputs(rnd));
      const answers = await Promise.all(cases.map((inputs) => engine.computePricingDetailed(inputs)));
      answers.forEach((answer, i) => {
        assert.equal(answer.source, 'python', `case ${start + i} was priced by ${answer.source} (${answer.kind})`);
        const expected = computePricing(cases[i]);
        const diff = pyCalcEngine.firstDifference(answer.result, expected);
        assert.equal(diff, null, `case ${start + i} differs at ${diff}: ${JSON.stringify(cases[i])}`);
        assert.equal(JSON.stringify(answer.result), JSON.stringify(expected));
        numbersCompared += countNumbers(expected);
        compared += 1;
      });
    }
    assert.equal(compared, PARITY_CASES);
    assert.equal(engine.stats().python, PARITY_CASES + 0);
    assert.deepEqual(engine.stats().fallback, {});
    console.info(`[PARITY] ${compared} prices, ${numbersCompared} numbers, all identical`);
  } finally {
    engine.stop();
  }
});

const EDGE_BASE = {
  netWt: 10,
  grossWt: 12,
  customPurityPercent: null,
  karatPurityPercent: 75,
  karatNumber: 18,
  goldRatePer10g: 80000,
  diamonds: [],
  colorstones: [],
  labourRatePerUnit: 0,
  labourUnit: 'Per Gram',
  labourWeightBasis: 'net',
  wastagePercent: 0,
  otherCharges: 0,
  labourChargeType: 'NONE',
  wastageCode: '',
};

const EDGE_CASES = {
  'all zero': { ...EDGE_BASE, netWt: 0, grossWt: 0, karatPurityPercent: 0, karatNumber: 0, goldRatePer10g: 0 },
  'karat missing from the rows: 18/24 of 100': { ...EDGE_BASE, karatPurityPercent: 0, karatNumber: 18 },
  '24K falls back to 100': { ...EDGE_BASE, karatPurityPercent: 0, karatNumber: 24 },
  'custom purity above 100 is 100': { ...EDGE_BASE, customPurityPercent: 104.5 },
  'custom purity below 0 is 0': { ...EDGE_BASE, customPurityPercent: -3 },
  'custom purity 0 beats the karat row': { ...EDGE_BASE, customPurityPercent: 0 },
  'karat above 24 is capped at 100': { ...EDGE_BASE, karatPurityPercent: 0, karatNumber: 30 },
  'discounts clamp to 0..100': {
    ...EDGE_BASE,
    diamonds: [
      { weight: 0.5, rate: 10000, discountPercent: 150 },
      { weight: 0.5, rate: 10000, discountPercent: -20 },
      { weight: 0.5, rate: 10000, discountPercent: 100 },
    ],
  },
  'signed zeros survive the wire': {
    ...EDGE_BASE,
    colorstones: [{ weight: 0, rate: -5 }, { weight: 0, rate: 7 }],
    diamonds: [{ weight: 0, rate: -5, discountPercent: 0 }],
  },
  'gross basis with no gross weight uses net': {
    ...EDGE_BASE, grossWt: 0, labourWeightBasis: 'gross', labourUnit: 'Per 10 Gram', labourRatePerUnit: 1450,
  },
  'negative labour rate charges nothing': { ...EDGE_BASE, labourRatePerUnit: -100 },
  'negative wastage charges nothing': { ...EDGE_BASE, wastagePercent: -5 },
  'thirty heavy stones': {
    ...EDGE_BASE,
    diamonds: Array.from({ length: 15 }, (_, i) => ({ weight: 5 - i * 0.001, rate: 199999.99, discountPercent: i })),
    colorstones: Array.from({ length: 15 }, (_, i) => ({ weight: 0.001 * (i + 1), rate: 49999.5 })),
  },
  'gold amount overflows to infinity (made 0 by the aggregation)': { ...EDGE_BASE, netWt: 1e308, goldRatePer10g: 1e308 },
  'a stone line overflows (not JSON: priced in Node)': {
    ...EDGE_BASE, colorstones: [{ weight: 1e308, rate: 1e308 }],
  },
  'tiny subnormal figures': { ...EDGE_BASE, netWt: 5e-324, otherCharges: 5e-324, goldRatePer10g: 3 },
  'unicode codes pass through': { ...EDGE_BASE, wastageCode: 'वेस्ट-८', labourChargeType: 'AMOUNT_GLOBAL' },
  'percent labour is a share of the gold amount': {
    ...EDGE_BASE, labourUnit: 'Percent', labourRatePerUnit: 8, labourChargeType: 'PERCENTAGE_GLOBAL',
  },
  'stones in grams are five carats a gram': {
    ...EDGE_BASE,
    diamonds: [{ weight: 0.1, rate: 50000, discountPercent: 5, unit: 'g' }],
    colorstones: [{ weight: 0.4, rate: 2000, unit: 'g' }, { weight: 0.4, rate: 2000, unit: 'ct' }, { weight: 0.4, rate: 2000, unit: null }],
  },
  'a blank net weight is gross less 0.2 g a carat': {
    ...EDGE_BASE, netWt: 0, grossWt: 8.208, diamonds: [{ weight: 0.54, rate: 55000, discountPercent: 0 }],
    wastagePercent: 8, labourUnit: 'Per Gram', labourRatePerUnit: 500,
  },
  'an estimated net weight is never below 0': {
    ...EDGE_BASE, netWt: 0, grossWt: 0.05, colorstones: [{ weight: 1, rate: 100, unit: 'g' }],
  },
  'an estimated net weight is rounded half-up to the milligram': {
    ...EDGE_BASE, netWt: 0, grossWt: 5.0005, colorstones: [],
  },
  'an MRP of exactly x.50 rounds up': {
    ...EDGE_BASE, netWt: 24.575, grossWt: 0, karatPurityPercent: 75, goldRatePer10g: 132400,
    labourUnit: 'Per Gram', labourRatePerUnit: 610,
  },
  'a negative MRP rounds away from zero': { ...EDGE_BASE, netWt: 0, grossWt: 0, otherCharges: -2.5 },
};

test('parity: edge cases give Node\'s figures whichever engine answers', { skip }, async () => {
  const engine = pyCalcEngine.createPyCalcEngine({ engine: 'python', logger: quietLogger });
  try {
    assert.equal(await engine.warm(), true);
    for (const [name, inputs] of Object.entries(EDGE_CASES)) {
      const answer = await engine.computePricingDetailed(inputs);
      const diff = pyCalcEngine.firstDifference(answer.result, computePricing(inputs));
      assert.equal(diff, null, `${name}: ${diff}`);
      if (name.includes('priced in Node')) {
        assert.equal(answer.source, 'fallback', name);
      } else {
        assert.equal(answer.source, 'python', `${name}: ${answer.kind}`);
      }
    }
    // The signed zeros really were exercised: a -0 line amount came back as -0.
    const zeros = (await engine.computePricingDetailed(EDGE_CASES['signed zeros survive the wire'])).result;
    assert.ok(Object.is(zeros.colorstoneLineItems[0].amount, -0));
    assert.ok(Object.is(zeros.colorstoneLineItems[1].amount, 0));
    // The new branches, from Python, with the figures they must have.
    const viaPython = async (name) => {
      const answer = await engine.computePricingDetailed(EDGE_CASES[name]);
      assert.equal(answer.source, 'python', name);
      return answer.result;
    };
    const tie = await viaPython('an MRP of exactly x.50 rounds up');
    assert.equal(tie.finalMRP, 259020.49999999997);
    assert.equal(tie.finalMRPRounded, 259021);
    assert.equal((await viaPython('a negative MRP rounds away from zero')).finalMRPRounded, -3);
    const blankNet = (await viaPython('a blank net weight is gross less 0.2 g a carat')).breakdown;
    assert.equal(blankNet.netWeightUsed, 8.1);
    assert.equal(blankNet.netWeightEstimated, true);
    assert.equal((await viaPython('an estimated net weight is never below 0')).breakdown.netWeightUsed, 0);
    assert.equal((await viaPython('an estimated net weight is rounded half-up to the milligram')).breakdown.netWeightUsed, 5.001);
    const grams = await viaPython('stones in grams are five carats a gram');
    assert.deepEqual(grams.colorstoneLineItems.map((line) => line.amount), [4000, 800, 800]);
    assert.equal(grams.diamondLineItems[0].weight, 0.5);
    const percent = await viaPython('percent labour is a share of the gold amount');
    assert.equal(percent.breakdown.labourAmount, percent.breakdown.goldAmount * 0.08);
  } finally {
    engine.stop();
  }
});

test('parity: MRPs of exactly x.50 round up to the same rupee in Python and Node, and correctly', { skip }, async () => {
  const engine = pyCalcEngine.createPyCalcEngine({ engine: 'python', logger: quietLogger });
  try {
    assert.equal(await engine.warm(), true);
    const rnd = seeded(5050);
    const ties = Array.from({ length: 3000 }, () => tieInputs(rnd));
    const answers = [];
    for (let start = 0; start < ties.length; start += BATCH) {
      const batch = ties.slice(start, start + BATCH);
      answers.push(...await Promise.all(batch.map(({ inputs }) => engine.computePricingDetailed(inputs))));
    }
    let floatBelowTie = 0;
    answers.forEach((answer, i) => {
      assert.equal(answer.source, 'python');
      assert.equal(pyCalcEngine.firstDifference(answer.result, computePricing(ties[i].inputs)), null);
      assert.equal(answer.result.finalMRPRounded, ties[i].exact, JSON.stringify(ties[i].inputs));
      if (Math.round(answer.result.finalMRP) !== ties[i].exact) floatBelowTie += 1;
    });
    // These are the cases Math.round (and Python's round / np.round, which
    // also take ties to even) got wrong; half-up on the snapped figure gets
    // every one right.
    assert.ok(floatBelowTie > 100, `${floatBelowTie} ties sat below the half in a float`);
  } finally {
    engine.stop();
  }
});

test('parity: the worker\'s round_half_up is money.js roundHalfUp, bit for bit; Python\'s round() is not', { skip }, () => {
  const { roundHalfUp } = require('../src/utils/money');
  const rnd = seeded(33);
  const values = [];
  const add = (value, decimals) => values.push([value, decimals]);
  // MRPs of exactly x.50 as the float has them, and their neighbours.
  for (let i = 0; i < 2000; i += 1) {
    const mrp = computePricing(tieInputs(rnd).inputs).finalMRP;
    add(mrp, 0);
    add(mrp * (1 + Number.EPSILON), 0);
    add(mrp * (1 - Number.EPSILON), 0);
  }
  // Karat rows (rate × purity) and rates with a paisa change, to the rupee.
  for (let i = 0; i < 3000; i += 1) {
    const rate = 80000 + Math.floor(rnd() * 120000);
    add(rate * ([91.6, 85, 75, 58.5, 39][i % 5] / 100), 0);
    add(rate + Math.floor(rnd() * 100) / 4, 0);
  }
  // Estimated net weights to the milligram, and paise.
  for (let i = 0; i < 3000; i += 1) {
    add(Math.floor(rnd() * 150000) / 1000 - 0.2 * (Math.floor(rnd() * 5000) / 1000), 3);
    add(Math.floor(rnd() * 20000000) / 1000 + 0.0005, 3);
    add((Math.floor(rnd() * 1e7) / 100) * 1.5, 2);
  }
  for (const [value, decimals] of [
    [2048.055, 2], [23607.499999999996, 0], [259020.49999999997, 0], [5.0005, 3], [-2.5, 0], [-0.0004, 3],
    [0.5, 0], [1.5, 0], [2.5, 0], [0, 0], [1e21, 0], [1.5e21, 0], [4503599627370495.5, 0], [5e-324, 3],
  ]) add(value, decimals);

  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(require('path').dirname(pyCalcEngine.WORKER_PATH))})`,
    'import calc_worker as w',
    'pairs = json.loads(sys.stdin.read())',
    'out = [[w.round_half_up(v, d), float(round(v, d))] for v, d in pairs]',
    'w.REPLIES.write(json.dumps(out).encode("utf-8"))',
    'w.REPLIES.flush()',
  ].join('\n');
  const run = spawnSync(PYTHON_BIN, ['-c', script], {
    input: JSON.stringify(values), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const answers = JSON.parse(run.stdout);
  let pythonRoundDiffers = 0;
  answers.forEach(([worker, builtin], i) => {
    const [value, decimals] = values[i];
    const expected = roundHalfUp(value, decimals);
    assert.ok(Object.is(worker, expected), `round_half_up(${value}, ${decimals}) = ${worker}, money.js ${expected}`);
    if (!Object.is(builtin, expected)) pythonRoundDiffers += 1;
  });
  // Ties to even, and floats a hair below the tie: the reason the worker
  // must not use round() or np.round.
  assert.ok(pythonRoundDiffers > 100, `round() differs on ${pythonRoundDiffers}`);
});

test('parity: inputs JSON cannot carry exactly are priced in Node, not sent', { skip }, async () => {
  const engine = pyCalcEngine.createPyCalcEngine({ engine: 'python', logger: quietLogger });
  try {
    assert.equal(await engine.warm(), true);
    const unsafe = [
      { ...EDGE_BASE, netWt: -0 },
      { ...EDGE_BASE, goldRatePer10g: undefined },
      { ...EDGE_BASE, karatPurityPercent: null },
      { ...EDGE_BASE, otherCharges: NaN },
      { ...EDGE_BASE, labourUnit: 5 },
      { ...EDGE_BASE, diamonds: [{ weight: Infinity, rate: 1, discountPercent: 0 }] },
    ];
    for (const inputs of unsafe) {
      assert.equal(pyCalcEngine.isWireSafe(inputs), false);
      const answer = await engine.computePricingDetailed(inputs);
      assert.equal(answer.source, 'fallback');
      assert.equal(answer.kind, 'unsupported-input');
      assert.equal(pyCalcEngine.firstDifference(answer.result, computePricing(inputs)), null);
    }
    assert.equal(engine.stats().fallback['unsupported-input'], unsafe.length);
  } finally {
    engine.stop();
  }
});

// ── computeMrp end to end: the same response whichever engine prices it ──

const calculationController = require('../src/controllers/calculation.controller');
const rateCalculationService = require('../src/services/rateCalculation.service');
const redisService = require('../src/services/redis.service');
const LabourRate = require('../src/models/labourRate.model');

test('computeMrp: the response is identical with CALC_ENGINE=python and CALC_ENGINE=js', { skip }, async (t) => {
  const originals = {
    getLiveGoldRates: rateCalculationService.getLiveGoldRates,
    getScan: redisService.getScan,
    updateScanStatus: redisService.updateScanStatus,
    labourFindOne: LabourRate.findOne,
  };
  rateCalculationService.getLiveGoldRates = async () => ({
    karatRates: [{ carat: '22Kt', purity: 91.6 }, { carat: '18Kt', purity: 75 }, { carat: '14Kt', purity: 58.5 }],
    taxSettings: { rtgsFinalRate: 152341, cashFinalRate: 151987.35 },
    supremeChanges: { rtgsChange: 0, cashChange: 0 },
  });
  redisService.getScan = async () => ({
    scanId: 'scan-1', ownerUserId: 'u1', businessId: 'b1', status: 'READY_FOR_REVIEW', calculationMode: 'rtgs',
  });
  redisService.updateScanStatus = async () => ({});
  LabourRate.findOne = async () => ({ chargeType: 'AMOUNT', value: 1450, rupeesUnit: 'Per 10 Gram' });
  const python = pyCalcEngine.createPyCalcEngine({ engine: 'python', logger: quietLogger });
  const js = pyCalcEngine.createPyCalcEngine({ engine: 'js', logger: quietLogger });
  const previous = pyCalcEngine.setDefaultEngine(python);
  const info = console.info;
  t.after(() => {
    console.info = info;
    pyCalcEngine.setDefaultEngine(previous);
    python.stop();
    rateCalculationService.getLiveGoldRates = originals.getLiveGoldRates;
    redisService.getScan = originals.getScan;
    redisService.updateScanStatus = originals.updateScanStatus;
    LabourRate.findOne = originals.labourFindOne;
  });
  assert.equal(await python.warm(), true);

  // Bodies /calculate accepts: the engine-level edge values the generator
  // also makes (a discount of 120, a purity of -2, a 'Per Piece' unit) are
  // refused with a 400 there, and are held identical by the tests above.
  const SENT_UNITS = new Set(['Per Gram', 'Per 10 Gram', 'Percent']);
  const rnd = seeded(7);
  const bodies = Array.from({ length: 200 }, () => {
    const inputs = realisticInputs(rnd);
    const unit = SENT_UNITS.has(inputs.labourUnit) ? inputs.labourUnit : 'Per Gram';
    const custom = inputs.customPurityPercent;
    const labourRate = unit === 'Percent' ? Math.min(100, inputs.labourRatePerUnit) : inputs.labourRatePerUnit;
    return {
      jewelleryType: 'DIAMOND',
      netWt: String(inputs.netWt),
      grossWt: inputs.grossWt,
      purityKarat: `${inputs.karatNumber}K`,
      customPurityPercent: custom !== null && custom > 0 && custom <= 100 ? custom : undefined,
      diamonds: inputs.diamonds.map((stone) => ({
        ...stone,
        discountPercent: Math.max(0, Math.min(100, stone.discountPercent)),
      })),
      colorstones: inputs.colorstones.map((stone) => ({ ...stone, weight: String(stone.weight) })),
      labourChargeAmount: rnd() < 0.5 ? String(labourRate) : undefined,
      labourChargeUnit: unit,
      labourWeightBasis: inputs.labourWeightBasis,
      wastagePercent: inputs.wastagePercent || undefined,
      otherCharges: inputs.otherCharges,
      calculationMode: rnd() < 0.5 ? 'cash' : 'rtgs',
    };
  });

  const respond = async (engine, body) => {
    pyCalcEngine.setDefaultEngine(engine);
    const audit = [];
    console.info = (...args) => audit.push(args.join(' '));
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
    let failure = null;
    await calculationController.calculateMRP(
      { params: { scanId: 'scan-1' }, user: { userId: 'u1', businessId: 'b1', role: 'OWNER' }, body },
      res,
      (error) => { failure = error; },
    );
    console.info = info;
    assert.equal(failure, null);
    return { body: res.body, audit };
  };

  for (const body of bodies) {
    const viaPython = await respond(python, body);
    const viaJs = await respond(js, body);
    assert.equal(pyCalcEngine.firstDifference(viaPython.body, viaJs.body), null);
    assert.equal(JSON.stringify(viaPython.body), JSON.stringify(viaJs.body));
    assert.deepEqual(viaPython.audit, viaJs.audit, 'the audit line is the same too');
  }
  assert.equal(python.stats().python, bodies.length, 'every response was priced in Python');
  assert.equal(js.stats().js, bodies.length);
  assert.equal(js.stats().spawns, 0);
});

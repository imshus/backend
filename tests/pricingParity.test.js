/**
 * The Python pricing worker (calc/calc_worker.py) and Node's pricingMath give
 * IDENTICAL figures: every number of every result compared with Object.is
 * (so even 0 and -0 differ), on seeded random realistic prices and on edge
 * cases, and computeMrp's response is the same object whichever engine
 * priced it.
 *
 * pricingMath rounds nothing (no Math.round, no toFixed: the only rounding
 * on the way to a price is Math.round inside getLiveGoldRates, which stays in
 * Node and reaches both engines as the same number), so identity of plain
 * IEEE double arithmetic is what is held here.
 *
 * Needs python with calc/requirements.txt; skipped, saying so, without it.
 */
process.env.USE_MEMORY_STORE = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const { computePricing } = require('../src/services/pricingMath');
const pyCalcEngine = require('../src/services/pyCalcEngine');
const { seeded, realisticInputs } = require('./fixtures/pycalc/realisticInputs');

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
  } finally {
    engine.stop();
  }
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

  const rnd = seeded(7);
  const bodies = Array.from({ length: 200 }, () => {
    const inputs = realisticInputs(rnd);
    return {
      jewelleryType: 'DIAMOND',
      netWt: String(inputs.netWt),
      grossWt: inputs.grossWt,
      purityKarat: `${inputs.karatNumber}K`,
      customPurityPercent: inputs.customPurityPercent ?? undefined,
      diamonds: inputs.diamonds,
      colorstones: inputs.colorstones.map((stone) => ({ ...stone, weight: String(stone.weight) })),
      labourChargeAmount: rnd() < 0.5 ? String(inputs.labourRatePerUnit) : undefined,
      labourChargeUnit: inputs.labourUnit,
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

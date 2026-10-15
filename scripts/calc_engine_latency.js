/**
 * How long the MRP arithmetic takes in Node (pricingMath) and in the Python
 * worker (calc/calc_worker.py, through the bridge), per call and inside a
 * whole computeMrp. No network and no paid calls: the reads computeMrp makes
 * are stood in for, as the tests do.
 *
 *   node scripts/calc_engine_latency.js            (from backend/)
 *   PYTHON_BIN=python3.9 node scripts/calc_engine_latency.js
 */
process.env.USE_MEMORY_STORE = 'true';

const { computePricing } = require('../src/services/pricingMath');
const pyCalcEngine = require('../src/services/pyCalcEngine');
const { seeded, realisticInputs } = require('../tests/fixtures/pycalc/realisticInputs');

const CALLS = Number(process.env.CALLS || 5000);

function summary(samplesNs) {
  const ms = samplesNs.map((ns) => Number(ns) / 1e6).sort((a, b) => a - b);
  const at = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
  const mean = ms.reduce((sum, v) => sum + v, 0) / ms.length;
  return { n: ms.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), mean };
}

const fmt = (s) => `n=${s.n}  p50 ${s.p50.toFixed(4)} ms  p95 ${s.p95.toFixed(4)} ms  p99 ${s.p99.toFixed(4)} ms  mean ${s.mean.toFixed(4)} ms`;

async function main() {
  const rnd = seeded(42);
  const cases = Array.from({ length: CALLS }, () => realisticInputs(rnd));
  const quiet = { info() {}, warn: console.warn };

  // 1. computePricing alone.
  for (const inputs of cases.slice(0, 500)) computePricing(inputs);
  const jsSamples = cases.map((inputs) => {
    const start = process.hrtime.bigint();
    computePricing(inputs);
    return process.hrtime.bigint() - start;
  });

  const python = pyCalcEngine.createPyCalcEngine({ engine: 'python', logger: quiet });
  const warmStart = Date.now();
  if (!(await python.warm())) throw new Error('the python worker did not start');
  const startupMs = Date.now() - warmStart;
  for (const inputs of cases.slice(0, 500)) await python.computePricing(inputs);
  const pySamples = [];
  for (const inputs of cases) {
    const start = process.hrtime.bigint();
    const answer = await python.computePricingDetailed(inputs);
    pySamples.push(process.hrtime.bigint() - start);
    if (answer.source !== 'python') throw new Error(`priced by ${answer.source} (${answer.kind})`);
  }

  // 2. A whole computeMrp, its reads stood in for (resolved at once).
  const rateCalculationService = require('../src/services/rateCalculation.service');
  const redisService = require('../src/services/redis.service');
  const LabourRate = require('../src/models/labourRate.model');
  const { computeMrp } = require('../src/services/mrpCalculation.service');
  rateCalculationService.getLiveGoldRates = async () => ({
    karatRates: [{ carat: '22Kt', purity: 91.6 }, { carat: '18Kt', purity: 75 }, { carat: '14Kt', purity: 58.5 }],
    taxSettings: { rtgsFinalRate: 152341, cashFinalRate: 151987.35 },
  });
  redisService.getScan = async () => ({ scanId: 's1', ownerUserId: 'u1', businessId: 'b1', status: 'READY_FOR_REVIEW' });
  LabourRate.findOne = async () => ({ chargeType: 'AMOUNT', value: 1450, rupeesUnit: 'Per 10 Gram' });
  const bodies = cases.slice(0, 2000).map((inputs) => ({
    netWt: inputs.netWt,
    grossWt: inputs.grossWt,
    purityKarat: `${inputs.karatNumber}K`,
    diamonds: inputs.diamonds,
    colorstones: inputs.colorstones,
    otherCharges: inputs.otherCharges,
    wastagePercent: inputs.wastagePercent,
  }));
  const info = console.info;
  console.info = () => {};
  const timeComputeMrp = async (engine) => {
    pyCalcEngine.setDefaultEngine(engine);
    const samples = [];
    for (const body of bodies) {
      const start = process.hrtime.bigint();
      await computeMrp({
        user: { userId: 'u1', businessId: 'b1', role: 'OWNER' },
        sessionContext: { userId: 'u1', businessId: 'b1', role: 'OWNER' },
        scanId: 's1',
        input: body,
      });
      samples.push(process.hrtime.bigint() - start);
    }
    return samples;
  };
  const jsEngine = pyCalcEngine.createPyCalcEngine({ engine: 'js', logger: quiet });
  await timeComputeMrp(jsEngine); // warm-up
  const mrpJs = await timeComputeMrp(jsEngine);
  await timeComputeMrp(python); // warm-up
  const mrpPy = await timeComputeMrp(python);
  console.info = info;

  const stats = python.stats();
  python.stop();

  const js = summary(jsSamples);
  const py = summary(pySamples);
  const mj = summary(mrpJs);
  const mp = summary(mrpPy);
  console.log(`worker startup (spawn + numpy/pandas import + probe): ${startupMs} ms`);
  console.log(`computePricing, Node:            ${fmt(js)}`);
  console.log(`computePricing, Python worker:   ${fmt(py)}`);
  console.log(`computeMrp, CALC_ENGINE=js:      ${fmt(mj)}`);
  console.log(`computeMrp, CALC_ENGINE=python:  ${fmt(mp)}`);
  console.log(`Python adds to computeMrp: p50 +${(mp.p50 - mj.p50).toFixed(3)} ms, p95 +${(mp.p95 - mj.p95).toFixed(3)} ms`);
  console.log(`worker served ${stats.python} calls, fell back ${JSON.stringify(stats.fallback)}`);
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});

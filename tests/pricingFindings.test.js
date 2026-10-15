/**
 * One regression per pricing finding from the October 2026 calculation
 * audit, each on the finding's own numbers: every one of these failed on the
 * code before the fix. The controller, computeMrp, deriveInputFromReading
 * and the pricing engine (CALC_ENGINE as set: python or js) are the real
 * ones; the database and the live rates are stood in for.
 *
 * The rates themselves (half-up rounding, no rate without an MCX) are in
 * tests/ratesHalfUp.test.js. Requests here come from the current app
 * (X-Pricing-Rules: 2); the builds before it, and the follow-up findings,
 * are in tests/pricingFollowups.test.js.
 */
process.env.USE_MEMORY_STORE = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const LabourRate = require('../src/models/labourRate.model');
const GoldTaxSetting = require('../src/models/goldTaxSetting.model');
const DiamondRate = require('../src/models/diamondRate.model');
const ColorstoneRate = require('../src/models/colorstoneRate.model');
const WastageCode = require('../src/models/wastageCode.model');
const ItemCode = require('../src/models/itemCode.model');
const rateCalculationService = require('../src/services/rateCalculation.service');
const redisService = require('../src/services/redis.service');
const scanService = require('../src/services/scan.service');
const scanController = require('../src/controllers/scan.controller');
const calculationController = require('../src/controllers/calculation.controller');
const {
  computeMrp,
  deriveInputFromReading,
  resolveKaratFromReading,
} = require('../src/services/mrpCalculation.service');
const { ratesUnavailable, findColorstoneRateMatch } = require('../src/services/pricingInputs');
const pyCalcEngine = require('../src/services/pyCalcEngine');

// With CALC_ENGINE=python these prices are the worker's, not Node's
// stand-in while it starts (with CALC_ENGINE=js this resolves at once).
test.before(async () => {
  await pyCalcEngine.getDefaultEngine().warm();
});

const BIZ = '507f1f77bcf86cd799439011';
const OWNER = { businessId: BIZ, userId: '507f1f77bcf86cd799439012', role: 'OWNER' };
const SESSION = { businessId: BIZ, userId: OWNER.userId, role: 'OWNER' };

const KARAT_ROWS = [
  { carat: '22Kt', purity: 91.6 },
  { carat: '20Kt', purity: 85 },
  { carat: '18Kt', purity: 75 },
  { carat: '14Kt', purity: 58.5 },
  { carat: '9Kt', purity: 39 },
];

const state = {};
const lookups = [];
const resetState = () => {
  Object.assign(state, {
    rtgs: 160000,
    cash: 155000,
    labour: { chargeType: 'NONE', value: 0 },
    itemRows: [],
    wastageRows: [],
    diamondRows: [],
    colorstoneRows: [],
    tax: { scannerCalculationUse: 'rtgs' },
    rates: null,
  });
  lookups.length = 0;
};
resetState();

const original = {
  getLiveGoldRates: rateCalculationService.getLiveGoldRates,
  labourFindOne: LabourRate.findOne,
  taxFindOne: GoldTaxSetting.findOne,
  diamondFind: DiamondRate.find,
  colorstoneFind: ColorstoneRate.find,
  wastageFind: WastageCode.find,
  itemFind: ItemCode.find,
  getScan: redisService.getScan,
  updateScanStatus: redisService.updateScanStatus,
  analyzeScan: scanService.analyzeScan,
};
test.after(() => {
  rateCalculationService.getLiveGoldRates = original.getLiveGoldRates;
  LabourRate.findOne = original.labourFindOne;
  GoldTaxSetting.findOne = original.taxFindOne;
  DiamondRate.find = original.diamondFind;
  ColorstoneRate.find = original.colorstoneFind;
  WastageCode.find = original.wastageFind;
  ItemCode.find = original.itemFind;
  redisService.getScan = original.getScan;
  redisService.updateScanStatus = original.updateScanStatus;
  scanService.analyzeScan = original.analyzeScan;
});

// The shop's records (no userId); every lookup is noted. A query on a code
// matches it exactly, as the database does.
const shopRows = (name, key) => async (query) => {
  lookups.push(name);
  if (query.userId) return [];
  return state[key].filter((row) => query.code === undefined || row.code === query.code);
};
const shopSetting = (name, key) => async (query) => {
  lookups.push(name);
  return query.userId ? null : state[key];
};
rateCalculationService.getLiveGoldRates = async () => {
  lookups.push('goldRates');
  if (typeof state.rates === 'function') return state.rates();
  return state.rates || {
    karatRates: KARAT_ROWS,
    taxSettings: { rtgsFinalRate: state.rtgs, cashFinalRate: state.cash },
  };
};
LabourRate.findOne = shopSetting('labour', 'labour');
GoldTaxSetting.findOne = shopSetting('tax', 'tax');
DiamondRate.find = shopRows('diamondRates', 'diamondRows');
ColorstoneRate.find = shopRows('colorstoneRates', 'colorstoneRows');
WastageCode.find = shopRows('wastageCodes', 'wastageRows');
ItemCode.find = shopRows('itemCodes', 'itemRows');
redisService.getScan = async () => ({
  scanId: 'scan-1', ownerUserId: OWNER.userId, businessId: BIZ, status: 'READY_FOR_REVIEW', calculationMode: 'rtgs',
});
redisService.updateScanStatus = async () => ({});

const quiet = async (fn) => {
  const info = console.info;
  const warn = console.warn;
  console.info = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.info = info;
    console.warn = warn;
  }
};

/** POST /scans/scan-1/calculate with `body`, through the real controller, from the current app. */
async function calculate(body, rules = 2) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  let failure = null;
  await quiet(() => calculationController.calculateMRP(
    { params: { scanId: 'scan-1' }, user: OWNER, body, headers: { 'x-pricing-rules': String(rules) } },
    res,
    (error) => { failure = error; },
  ));
  if (failure) throw failure;
  return res;
}

/** The priced answer for `body`; fails the test on anything but a 200. */
async function priced(body) {
  const res = await calculate(body);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.data;
}

const field = (value, confidence = 95) => ({ value, confidence });
const scanFor = (structuredData, unknownFields = []) => ({
  scanId: 'scan-1',
  status: 'ANALYSIS_COMPLETED',
  jewelleryType: 'GOLD',
  ownerUserId: OWNER.userId,
  businessId: BIZ,
  calculationMode: 'rtgs',
  analysisResult: { provider: 'openai', rawText: {}, structuredData, unknownFields, overallConfidence: 90 },
});

/** The analysis's own price for a reading, for the current app: the input it derives and the MRP. */
async function analyzePrice(structuredData, unknownFields = [], rules = 2) {
  const scan = scanFor(structuredData, unknownFields);
  return quiet(async () => {
    const pricingInput = await deriveInputFromReading({ user: OWNER, structuredData, scan, rules });
    const computed = await computeMrp({
      user: OWNER, sessionContext: SESSION, scanId: 'scan-1', input: pricingInput, scan, rules,
    });
    return { pricingInput, pricing: computed.resultData };
  });
}

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message || 'value'}: ${actual} is not ${expected}`);

// ── #0, #12: the karat ───────────────────────────────────────────────────

test('#0 the analysis reads the karat off the reader\'s field object: 22K, not the 14K default', async () => {
  resetState();
  const { pricingInput, pricing } = await analyzePrice({
    netWeight: field('10'),
    karat: field('22K'),
  });
  assert.equal(pricingInput.purityKarat, '22K');
  near(pricing.breakdown.pureWeight, 9.16, 'pure weight');
  near(pricing.finalMRP, 146560, 'MRP');
  assert.equal(pricing.finalMRPRounded, 146560);
});

test('#0/#12 fineness and karats a tag prints resolve as the app reads them, 23K/21K/10K included', () => {
  const cases = [
    [{ purity: field('958') }, '23K'],
    [{ purity: field('875') }, '21K'],
    // 625 (15K) is not a karat the app reads, so neither does the server.
    [{ purity: field('625') }, '14K'],
    [{ karat: field('15K') }, '14K'],
    [{ purity: field('417') }, '10K'],
    [{ purity: field('916') }, '22K'],
    [{ purity: field('91.6') }, '22K'],
    [{ purity: field('750') }, '18K'],
    [{ purity: field('585') }, '14K'],
    [{ karat: field('23K') }, '23K'],
    [{ karat: field('21 KT') }, '21K'],
    [{ karat: field('10k') }, '10K'],
    [{ karat: field('22') }, '22K'],
    [{ karat: field('22KT916') }, '22K'],
    [{ karat: '18K' }, '18K'],
    // Nothing on the tag, or nothing a karat: the default the app uses too.
    [{}, '14K'],
    [{ purity: field('800') }, '14K'],
  ];
  for (const [data, karat] of cases) {
    assert.equal(resolveKaratFromReading(data), karat, JSON.stringify(data));
  }
});

test('#12 /calculate prices a fineness or a numeric karat: 958 is 23K (23/24), 22 is 22K', async () => {
  resetState();
  const fineness = await priced({ netWt: 10, purityKarat: '958' });
  near(fineness.breakdown.pureWeight, 10 * ((23 / 24) * 100) / 100, 'pure weight at 23/24');
  // A karat sent as a number used to throw a TypeError (HTTP 500).
  const numeric = await priced({ netWt: 10, purityKarat: 22 });
  near(numeric.finalMRP, 146560, '22K MRP');
});

// ── #1: item-code wastage on a tag number with a running number ──────────

test('#1 the tag GR10286 is item GR in Masters: its 8% wastage is charged', async () => {
  resetState();
  state.itemRows = [{ code: 'GR', wastage: 8, labour: null }];
  for (const itemCode of ['GR10286', 'gr10286', 'GR-10286', 'GR 10286']) {
    const data = await priced({ netWt: 10, purityKarat: '22K', itemCode });
    near(data.breakdown.wastageAmount, 12800, `${itemCode} wastage`);
    near(data.finalMRP, 159360, `${itemCode} MRP`);
  }
  // Named by an identifier the reader set aside, the item number being an SR NO.
  const aside = await priced({ netWt: 10, purityKarat: '22K', itemCode: '261440', tagIdentifiers: ['261440', 'GR10286'] });
  near(aside.breakdown.wastageAmount, 12800, 'wastage via a set-aside identifier');
});

test('#1 a prefix only names an item when digits follow it, and the longest code wins', async () => {
  resetState();
  state.itemRows = [{ code: 'GR', wastage: 8, labour: null }, { code: 'G', wastage: 50, labour: null }];
  assert.equal((await priced({ netWt: 10, purityKarat: '22K', itemCode: 'GRT500' })).breakdown.wastageAmount, 0);
  assert.equal((await priced({ netWt: 10, purityKarat: '22K', itemCode: 'G1234' })).breakdown.wastageAmount, 0,
    'one letter is too little to name an item');
  state.itemRows.push({ code: 'GRT', wastage: 10, labour: null });
  near((await priced({ netWt: 10, purityKarat: '22K', itemCode: 'GRT500' })).breakdown.wastageAmount, 16000, 'GRT');
  near((await priced({ netWt: 10, purityKarat: '22K', itemCode: 'GR10286' })).breakdown.wastageAmount, 12800, 'GR');
});

// ── #2: a blank net weight ───────────────────────────────────────────────

test('#2 a blank net weight is the gross weight less the stones: the gold is priced, flagged as estimated', async () => {
  resetState();
  state.itemRows = [{ code: 'GR', wastage: 8, labour: null }];
  const data = await priced({
    netWt: 0,
    grossWt: 6.75,
    purityKarat: '22K',
    labourChargeAmount: '500',
    labourChargeUnit: 'Per Gram',
    labourWeightBasis: 'gross',
    itemCode: 'GR',
  });
  near(data.breakdown.goldAmount, 98928, 'gold');
  near(data.breakdown.wastageAmount, 8640, 'wastage');
  near(data.breakdown.labourAmount, 3375, 'labour');
  assert.equal(data.finalMRPRounded, 110943);
  assert.equal(data.breakdown.netWeightUsed, 6.75);
  assert.equal(data.breakdown.netWeightEstimated, true);

  // With stones: 8.208 g gross less 0.54 ct at 0.2 g a carat is 8.100 g.
  const withStones = await priced({
    netWt: '', grossWt: '8.208', purityKarat: '18K', diamonds: [{ weight: 0.54, rate: 55000 }],
  });
  assert.equal(withStones.breakdown.netWeightUsed, 8.1);
  // A net weight the tag printed is used as it is, and not flagged.
  const printed = await priced({ netWt: 8.1, grossWt: 8.208, purityKarat: '18K' });
  assert.equal(printed.breakdown.netWeightEstimated, false);
});

test('#2 a plain tag with only "Weight 6.750": the analysis prices the gold too', async () => {
  resetState();
  const { pricingInput, pricing } = await analyzePrice({ grossWeight: field('6.750'), netWeight: field(''), purity: field('916') });
  assert.equal(pricingInput.netWt, 0);
  assert.equal(pricing.breakdown.netWeightEstimated, true);
  near(pricing.breakdown.goldAmount, 98928, 'gold');
});

// ── #3: PERCENTAGE labour ────────────────────────────────────────────────

test('#3 a PERCENTAGE labour charge is that percent of the gold value, not rupees per gram', async () => {
  resetState();
  state.labour = { chargeType: 'PERCENTAGE', value: 8 };
  const data = await priced({ netWt: 10, purityKarat: '22K' });
  near(data.breakdown.labourAmount, 11724.8, 'labour');
  assert.equal(data.breakdown.labourChargeType, 'PERCENTAGE_GLOBAL');
  assert.equal(data.finalMRPRounded, 158285);

  // The same from the analysis.
  const { pricing } = await analyzePrice({ netWeight: field('10'), karat: field('22K') });
  near(pricing.breakdown.labourAmount, 11724.8, 'analysis labour');
});

test('#3 a tag\'s "12%" labour is priced: by the analysis, and on /calculate as "12%" or unit Percent', async () => {
  resetState();
  state.labour = { chargeType: 'AMOUNT', value: 500, rupeesUnit: 'Per Gram', weightBasis: 'net' };
  const { pricingInput, pricing } = await analyzePrice({ netWeight: field('10'), karat: field('22K'), labour: field('12%') });
  assert.equal(pricingInput.labourChargeAmount, '12');
  assert.equal(pricingInput.labourChargeUnit, 'Percent');
  near(pricing.breakdown.labourAmount, 17587.2, 'analysis labour');
  for (const body of [
    { labourChargeAmount: '12%' },
    { labourChargeAmount: '12', labourChargeUnit: 'Percent' },
  ]) {
    const data = await priced({ netWt: 10, purityKarat: '22K', ...body });
    near(data.breakdown.labourAmount, 17587.2, JSON.stringify(body));
    assert.equal(data.breakdown.labourChargeType, 'PERCENTAGE_MANUAL');
  }
});

// ── #4, #19: the analysis prices from what the app sends ─────────────────

/** The request the app builds from the same reading (pricingPrefetch.derivePricingInput after the card's set-up). */
const appPayload = (overrides) => ({
  jewelleryType: 'GOLD',
  netWt: 10,
  grossWt: 12,
  purityKarat: '22K',
  labourChargeAmount: '',
  labourChargeUnit: 'Per Gram',
  labourWeightBasis: 'net',
  calculationMode: 'rtgs',
  otherCharges: 0,
  diamonds: [],
  colorstones: [],
  ...overrides,
});

const sameFigures = (analysis, card) => {
  for (const key of ['goldAmount', 'labourAmount', 'wastageAmount', 'otherCharges', 'diamondAmount', 'colorstoneAmount']) {
    near(analysis.breakdown[key], card.breakdown[key], key);
  }
  assert.equal(analysis.finalMRP, card.finalMRP);
  assert.equal(analysis.finalMRPRounded, card.finalMRPRounded);
};

test('#4a/#19 the shop\'s labour runs on the weight it was saved against (gross), as the card charges it', async () => {
  resetState();
  state.labour = { chargeType: 'AMOUNT', value: 500, rupeesUnit: 'Per Gram', weightBasis: 'gross' };
  const { pricing } = await analyzePrice({ netWeight: field('10'), grossWeight: field('12'), karat: field('22K') });
  near(pricing.breakdown.labourAmount, 6000, 'labour on 12 g gross');
  // The app prefills the shop's labour with its weight basis and sends it.
  const card = await priced(appPayload({ labourChargeAmount: '500', labourWeightBasis: 'gross' }));
  sameFigures(pricing, card);
  near(pricing.finalMRP, 152560, 'MRP');
});

test('#4b the labour and other charges the tag prints are priced by the analysis, as the card prices them', async () => {
  resetState();
  state.labour = { chargeType: 'AMOUNT', value: 500, rupeesUnit: 'Per Gram', weightBasis: 'gross' };
  const { pricingInput, pricing } = await analyzePrice({
    netWeight: field('10'),
    grossWeight: field('12'),
    karat: field('22K'),
    labour: field('650'),
    otherCharges: field('1500'),
  });
  assert.equal(pricingInput.otherCharges, 1500);
  near(pricing.breakdown.labourAmount, 6500, 'tag labour on net');
  const card = await priced(appPayload({ labourChargeAmount: '650', otherCharges: 1500 }));
  sameFigures(pricing, card);
});

test('#4c the analysis finds the Masters item from the tag number, as the card does', async () => {
  resetState();
  state.itemRows = [{ code: 'GR', wastage: 8, labour: null }];
  const { pricing } = await analyzePrice({ serialNumber: field('GR10286'), netWeight: field('10'), karat: field('22K') });
  near(pricing.breakdown.wastageAmount, 12800, 'item wastage');
  const card = await priced(appPayload({ itemCode: 'GR10286', tagIdentifiers: ['GR10286'] }));
  sameFigures(pricing, card);
});

// ── #5: colour-stone rate rows ───────────────────────────────────────────

test('#5 a colour stone is priced at its packet\'s row, and a blank stone keeps its printed rate', async () => {
  resetState();
  state.colorstoneRows = [
    { packetCode: 'RUBY-A', color: '', clarity: '', rate: 5000 },
    { packetCode: 'EM-B', color: '', clarity: '', rate: 20000 },
    { packetCode: '', color: 'RED', clarity: 'SI', rate: 1200 },
  ];
  const { pricingInput, pricing } = await analyzePrice({
    netWeight: field('5'),
    karat: field('18K'),
    colorstones: [
      { weight: field('1.2'), packetCode: field('EM-B'), color: field(''), clarity: field(''), rate: field('') },
      { weight: field('0.5'), color: field(''), clarity: field(''), rate: field('800') },
      { weight: field('0.2'), color: field('red'), clarity: field('SI'), rate: field('') },
    ],
  });
  assert.deepEqual(pricingInput.colorstones.map((stone) => stone.rate), [20000, 800, 1200]);
  near(pricing.breakdown.colorstoneAmount, 1.2 * 20000 + 0.5 * 800 + 0.2 * 1200, 'colour stones');
  // A packet row is never matched by colour and clarity, and blanks match nothing.
  assert.equal(findColorstoneRateMatch(state.colorstoneRows, { color: '', clarity: '' }), null);
  assert.equal(findColorstoneRateMatch(state.colorstoneRows, { packetCode: 'NOPE' }), null);
});

// ── #6: colour-stone weights in grams ────────────────────────────────────

test('#6 a colour-stone weight printed in grams is priced in carats (0.40 g is 2 ct)', async () => {
  resetState();
  // Read off the weight's own text, and off the reader's unit field.
  for (const stone of [
    { weight: field('0.40 g'), rate: field('2000') },
    { weight: field('0.40gms'), rate: field('2000') },
    { weight: field('0.40'), unit: field('g'), rate: field('2000') },
  ]) {
    const { pricingInput, pricing } = await analyzePrice({ netWeight: field('5'), karat: field('18K'), colorstones: [stone] });
    assert.equal(pricingInput.colorstones[0].unit, 'g');
    near(pricing.breakdown.colorstoneAmount, 4000, JSON.stringify(stone));
  }
  // A weight with no unit stays carats.
  const carats = await analyzePrice({ netWeight: field('5'), karat: field('18K'), colorstones: [{ weight: field('0.40'), rate: field('2000') }] });
  near(carats.pricing.breakdown.colorstoneAmount, 800, 'carats');
  // /calculate takes the unit per stone row.
  near((await priced({ netWt: 5, purityKarat: '18K', colorstones: [{ weight: 0.4, rate: 2000, unit: 'g' }] }))
    .breakdown.colorstoneAmount, 4000, '/calculate grams');
  near((await priced({ netWt: 5, purityKarat: '18K', colorstones: [{ weight: 0.4, rate: 2000, unit: 'ct' }] }))
    .breakdown.colorstoneAmount, 800, '/calculate carats');
});

// ── #7: no live rate, no price ───────────────────────────────────────────

test('#7 with no live gold rate /calculate answers 503 RATES_UNAVAILABLE instead of pricing gold at Rs 0', async () => {
  resetState();
  state.rates = { karatRates: KARAT_ROWS, taxSettings: {} };
  const res = await calculate({ netWt: 10, purityKarat: '22K', labourChargeAmount: '500' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'RATES_UNAVAILABLE');
  assert.match(res.body.message, /unavailable/i);

  // The rate service itself refusing (no board MCX, no stored MCX).
  state.rates = () => { throw ratesUnavailable(); };
  const refused = await calculate({ netWt: 10, purityKarat: '22K' });
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.body.error, 'RATES_UNAVAILABLE');
});

test('#7 the analysis says why it has no price when there is no live rate', async () => {
  resetState();
  state.rates = () => { throw ratesUnavailable(); };
  const scan = scanFor({ netWeight: field('10'), karat: field('22K') });
  scanService.analyzeScan = async () => JSON.parse(JSON.stringify(scan));
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  let failure = null;
  await quiet(() => scanController.analyzeScan(
    { params: { scanId: 'scan-1' }, body: {}, user: OWNER, licenseContext: null },
    res,
    (error) => { failure = error; },
  ));
  assert.equal(failure, null);
  assert.equal(res.body.data.pricing, null);
  assert.equal(res.body.data.pricingError.code, 'RATES_UNAVAILABLE');
});

// ── #8: the item's own labour ────────────────────────────────────────────

test('#8 the labour saved on the Masters item is charged (rupees per gram) ahead of the shop\'s', async () => {
  resetState();
  state.labour = { chargeType: 'AMOUNT', value: 500, rupeesUnit: 'Per Gram', weightBasis: 'net' };
  state.itemRows = [{ code: 'GR', wastage: null, labour: 700 }];
  const data = await priced({ netWt: 10, purityKarat: '22K', itemCode: 'GR10286' });
  near(data.breakdown.labourAmount, 7000, 'item labour');
  assert.equal(data.breakdown.labourChargeType, 'AMOUNT_ITEM');
  // A figure typed for the scan still wins.
  near((await priced({ netWt: 10, purityKarat: '22K', itemCode: 'GR10286', labourChargeAmount: '600' }))
    .breakdown.labourAmount, 6000, 'manual labour');
  // Without the item, the shop's.
  near((await priced({ netWt: 10, purityKarat: '22K' })).breakdown.labourAmount, 5000, 'shop labour');
});

// ── #9: what /calculate refuses ──────────────────────────────────────────

test('#9 /calculate refuses negative, out-of-range and wrongly typed figures with a 400 that names the field', async () => {
  resetState();
  const refusals = [
    [{ netWt: -10 }, /netWt cannot be negative/],
    [{ grossWt: 'abc' }, /grossWt must be a number/],
    [{ netWt: 1e308 }, /netWt cannot be more than/],
    [{ diamonds: [{ weight: -0.5, rate: 50000 }] }, /diamonds\[0\]\.weight cannot be negative/],
    [{ diamonds: [{ weight: 0.5, rate: 50000, discountPercent: 120 }] }, /discountPercent cannot be more than 100/],
    [{ diamonds: 'two stones' }, /diamonds must be a list/],
    [{ colorstones: [{ weight: 0.4, rate: 2000, unit: 'kg' }] }, /unit must be "ct"/],
    [{ wastagePercent: 150 }, /wastagePercent cannot be more than 100/],
    [{ wastagePercent: -5 }, /wastagePercent cannot be negative/],
    [{ customPurityPercent: 120 }, /customPurityPercent cannot be more than 100/],
    [{ customPurityPercent: -1 }, /customPurityPercent cannot be negative/],
    [{ purityKarat: '30K' }, /purityKarat "30K" is not a karat/],
    [{ purityKarat: { karat: 22 } }, /purityKarat must be a karat/],
    [{ labourChargeAmount: '-500' }, /labourChargeAmount cannot be negative/],
    [{ labourChargeAmount: '150%' }, /labourChargeAmount cannot be more than 100/],
    [{ labourChargeUnit: 'Per Piece', labourChargeAmount: '500' }, /labourChargeUnit must be/],
    [{ labourWeightBasis: 'volume' }, /labourWeightBasis must be/],
    [{ otherCharges: -100 }, /otherCharges cannot be negative/],
  ];
  for (const [overrides, message] of refusals) {
    lookups.length = 0;
    const res = await calculate({ netWt: 10, purityKarat: '22K', ...overrides });
    assert.equal(res.statusCode, 400, JSON.stringify(overrides));
    assert.equal(res.body.error, 'INVALID_PRICING_INPUT');
    assert.match(res.body.message, message);
    assert.deepEqual(lookups, [], 'refused before anything is read');
  }
});

test('#9 a custom purity of 0 is "not set": the karat\'s purity prices the gold', async () => {
  resetState();
  const data = await priced({ netWt: 10, purityKarat: '22K', customPurityPercent: 0 });
  near(data.breakdown.pureWeight, 9.16, 'pure weight');
  near(data.finalMRP, 146560, 'MRP');
});

// ── #22, #38: the MRP to the rupee ───────────────────────────────────────

test('#22/#38 an MRP of exactly x.50 is rounded up to the rupee (the float sits just below the tie)', async () => {
  resetState();
  state.rtgs = 132400;
  const data = await priced({
    netWt: 24.575, purityKarat: '18K', labourChargeAmount: '610', labourChargeUnit: 'Per Gram', labourWeightBasis: 'net',
  });
  assert.equal(data.finalMRP, 259020.49999999997);
  assert.equal(data.finalMRPRounded, 259021);

  state.rtgs = 120000;
  const gold = await priced({ netWt: 1.875, purityKarat: '14K' });
  assert.equal(gold.finalMRP, 13162.499999999998);
  assert.equal(gold.finalMRPRounded, 13163);
});

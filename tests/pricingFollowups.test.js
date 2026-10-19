/**
 * The follow-up findings on the October 2026 pricing fixes: the price the
 * analysis makes first, the price the card asks for (/calculate with the
 * body the app really sends) and so the invoice must be one figure, for
 * 1.0.367 (X-Pricing-Rules: 2) and for the builds already in shops (no
 * header, rules 1). Rules 3's wastage is in tests/wastageCurrentRate.test.js.
 *
 * `appPayload` is pricingPrefetch.derivePricingInput's body after
 * processing.tsx: what the card sends, not a hand-built body. The
 * controller, computeMrp, deriveInputFromReading and pricingMath are the
 * real ones; the database and the live rates
 * are stood in for.
 */
process.env.USE_MEMORY_STORE = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const LabourRate = require('../src/models/labourRate.model');
const GoldTaxSetting = require('../src/models/goldTaxSetting.model');
const DiamondRate = require('../src/models/diamondRate.model');
const ColorstoneRate = require('../src/models/colorstoneRate.model');
const WastageCode = require('../src/models/wastageCode.model');
const LabourCode = require('../src/models/labourCode.model');
const ItemCode = require('../src/models/itemCode.model');
const rateCalculationService = require('../src/services/rateCalculation.service');
const redisService = require('../src/services/redis.service');
const calculationController = require('../src/controllers/calculation.controller');
const { computeMrp, deriveInputFromReading } = require('../src/services/mrpCalculation.service');
const {
  pricingRulesOf,
  SCANNABLE_KARAT_NUMBERS,
  FINENESS_STANDARDS,
} = require('../src/services/pricingInputs');
const { computeInvoiceFigures, InvoiceInputError } = require('../src/services/invoiceMath');

const BIZ = '507f1f77bcf86cd799439011';
const OWNER = { businessId: BIZ, userId: '507f1f77bcf86cd799439012', role: 'OWNER' };
const SESSION = { businessId: BIZ, userId: OWNER.userId, role: 'OWNER' };
const KARAT_ROWS = [
  { carat: '22Kt', purity: 91.6 },
  { carat: '18Kt', purity: 75 },
  { carat: '14Kt', purity: 58.5 },
];

const state = {};
const resetState = () => {
  Object.assign(state, {
    rtgs: 160000,
    labour: { chargeType: 'NONE', value: 0 },
    itemRows: [],
    wastageRows: [],
    diamondRows: [],
    colorstoneRows: [],
    tax: { scannerCalculationUse: 'rtgs' },
  });
};
resetState();

const original = {
  getLiveGoldRates: rateCalculationService.getLiveGoldRates,
  labourFindOne: LabourRate.findOne,
  taxFindOne: GoldTaxSetting.findOne,
  diamondFind: DiamondRate.find,
  colorstoneFind: ColorstoneRate.find,
  wastageFind: WastageCode.find,
  labourCodeFind: LabourCode.find,
  itemFind: ItemCode.find,
  getScan: redisService.getScan,
  updateScanStatus: redisService.updateScanStatus,
};
test.after(() => {
  rateCalculationService.getLiveGoldRates = original.getLiveGoldRates;
  LabourRate.findOne = original.labourFindOne;
  GoldTaxSetting.findOne = original.taxFindOne;
  DiamondRate.find = original.diamondFind;
  ColorstoneRate.find = original.colorstoneFind;
  WastageCode.find = original.wastageFind;
  LabourCode.find = original.labourCodeFind;
  ItemCode.find = original.itemFind;
  redisService.getScan = original.getScan;
  redisService.updateScanStatus = original.updateScanStatus;
});

const shopRows = (key) => async (query) => (query.userId ? [] : state[key]);
const shopSetting = (key) => async (query) => (query.userId ? null : state[key]);
rateCalculationService.getLiveGoldRates = async () => ({
  karatRates: KARAT_ROWS,
  taxSettings: { rtgsFinalRate: state.rtgs, cashFinalRate: state.rtgs },
});
LabourRate.findOne = shopSetting('labour');
GoldTaxSetting.findOne = shopSetting('tax');
DiamondRate.find = shopRows('diamondRows');
ColorstoneRate.find = shopRows('colorstoneRows');
WastageCode.find = shopRows('wastageRows');
// No labour codes saved: the labour is priced exactly as before them.
LabourCode.find = async () => [];
ItemCode.find = shopRows('itemRows');
redisService.getScan = async () => ({
  scanId: 'scan-1', ownerUserId: OWNER.userId, businessId: BIZ, status: 'READY_FOR_REVIEW', calculationMode: 'rtgs',
});
redisService.updateScanStatus = async () => ({});

const quiet = async (fn) => {
  const { info, warn } = console;
  console.info = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.info = info;
    console.warn = warn;
  }
};

/** POST /scans/scan-1/calculate through the real controller; rules 1 sends no header, as the builds in shops. */
async function calculate(body, rules) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  let failure = null;
  const headers = rules >= 2 ? { 'x-pricing-rules': String(rules) } : {};
  await quiet(() => calculationController.calculateMRP(
    { params: { scanId: 'scan-1' }, user: OWNER, body, headers },
    res,
    (error) => { failure = error; },
  ));
  if (failure) throw failure;
  return res;
}

async function priced(body, rules) {
  const res = await calculate(body, rules);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.data;
}

const field = (value, confidence = 95) => ({ value, confidence });
const scanFor = (structuredData) => ({
  scanId: 'scan-1',
  status: 'ANALYSIS_COMPLETED',
  jewelleryType: 'GOLD',
  ownerUserId: OWNER.userId,
  businessId: BIZ,
  calculationMode: 'rtgs',
  analysisResult: { provider: 'openai', rawText: {}, structuredData, unknownFields: [], overallConfidence: 90 },
});

/** The analysis's own price for a reading, for the build on `rules`. */
async function analyzePrice(structuredData, rules) {
  const scan = scanFor(structuredData);
  return quiet(async () => {
    const pricingInput = await deriveInputFromReading({ user: OWNER, structuredData, scan, rules });
    const computed = await computeMrp({
      user: OWNER, sessionContext: SESSION, scanId: 'scan-1', input: pricingInput, scan, rules,
    });
    return { pricingInput, pricing: computed.resultData };
  });
}

/**
 * The body the app sends for the card's first price (derivePricingInput):
 * labour fields as processing.tsx filled them, stone rows as the card holds
 * them. The current app adds each stone's unit; the builds in shops send
 * { weight, rate(, discountPercent) } only.
 */
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

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message || 'value'}: ${actual} is not ${expected}`);

const sameFigures = (analysis, card, message = '') => {
  for (const key of ['goldAmount', 'labourAmount', 'wastageAmount', 'otherCharges', 'diamondAmount', 'colorstoneAmount']) {
    near(analysis.breakdown[key], card.breakdown[key], `${message} ${key}`);
  }
  assert.equal(analysis.finalMRP, card.finalMRP, `${message} finalMRP`);
  assert.equal(analysis.finalMRPRounded, card.finalMRPRounded, `${message} finalMRPRounded`);
};

const GR10286 = { serialNumber: field('GR10286'), netWeight: field('10'), grossWeight: field('12'), karat: field('22K') };

// ── Which build is asking ────────────────────────────────────────────────

test('the pricing rules come from X-Pricing-Rules: 4, 3 and 2 as sent, 1 from builds that send none', () => {
  assert.equal(pricingRulesOf({ headers: { 'x-pricing-rules': '2' } }), 2);
  assert.equal(pricingRulesOf({ get: (name) => (name === 'x-pricing-rules' ? '3' : undefined) }), 3);
  assert.equal(pricingRulesOf({ headers: { 'x-pricing-rules': '4' } }), 4);
  // A build newer than the server gets the newest rules it knows; 1.0.367
  // keeps rules 2, and the build on rules 3 keeps 3, now the current are 4.
  assert.equal(pricingRulesOf({ headers: { 'x-pricing-rules': '9' } }), 4);
  assert.equal(pricingRulesOf({ headers: { 'x-pricing-rules': '1' } }), 1);
  assert.equal(pricingRulesOf({ headers: { 'x-pricing-rules': '0' } }), 1);
  assert.equal(pricingRulesOf({ headers: {} }), 1);
  assert.equal(pricingRulesOf({ headers: { 'x-pricing-rules': 'abc' } }), 1);
  assert.equal(pricingRulesOf(undefined), 1);
});

// ── 1, 10(1): item labour, priced where it is billed ─────────────────────

test('1/10 item GR\'s labour (700) is the card\'s labour: the analysis equals the body the app sends', async () => {
  resetState();
  state.labour = { chargeType: 'AMOUNT', value: 500, rupeesUnit: 'Per Gram', weightBasis: 'net' };
  state.itemRows = [{ code: 'GR', wastage: null, labour: 700 }];
  const { pricingInput, pricing } = await analyzePrice(GR10286, 2);
  assert.equal(pricingInput.labourChargeAmount, '700');
  near(pricing.breakdown.labourAmount, 7000, 'analysis labour');
  assert.equal(pricing.finalMRPRounded, 153560);
  // The app fills the labour box with the item's 700, not the shop's 500.
  const card = await priced(appPayload({
    labourChargeAmount: '700', itemCode: 'GR10286', tagIdentifiers: ['GR10286'],
  }), 2);
  sameFigures(pricing, card, 'rules 2');
});

test('1/10 a build in shops prefills the shop\'s 500 and never charged item labour: its first price is that', async () => {
  resetState();
  state.labour = { chargeType: 'AMOUNT', value: 500, rupeesUnit: 'Per Gram', weightBasis: 'net' };
  state.itemRows = [{ code: 'GR', wastage: null, labour: 700 }];
  const { pricingInput, pricing } = await analyzePrice(GR10286, 1);
  assert.equal(pricingInput.labourChargeAmount, '500');
  const card = await priced(appPayload({
    labourChargeAmount: '500', itemCode: 'GR10286', tagIdentifiers: ['GR10286'],
  }), 1);
  sameFigures(pricing, card, 'rules 1');
  assert.equal(card.finalMRPRounded, 151560);
});

// ── 11: item labour in its own unit, whatever the shop's labour type ─────

test('11 item labour is priced in the unit saved with it, and the same whatever the shop\'s labour type', async () => {
  for (const shop of [
    { chargeType: 'AMOUNT', value: 500, rupeesUnit: 'Per Gram', weightBasis: 'net' },
    { chargeType: 'PERCENTAGE', value: 8, weightBasis: 'net' },
    { chargeType: 'NONE', value: 0 },
  ]) {
    for (const [item, labour] of [
      [{ code: 'GR', labour: 700 }, 7000],
      [{ code: 'GR', labour: 700, labourUnit: 'Per Gram' }, 7000],
      [{ code: 'GR', labour: 7000, labourUnit: 'Per 10 Gram' }, 7000],
      [{ code: 'GR', labour: 12, labourUnit: 'Percent' }, 17587.2],
    ]) {
      resetState();
      state.labour = shop;
      state.itemRows = [{ wastage: null, ...item }];
      const label = `${shop.chargeType} shop, item ${JSON.stringify(item)}`;
      const { pricingInput, pricing } = await analyzePrice(GR10286, 2);
      near(pricing.breakdown.labourAmount, labour, `${label}: analysis`);
      // The app sends the item's figure and unit it filled the box with.
      const card = await priced(appPayload({
        labourChargeAmount: pricingInput.labourChargeAmount,
        labourChargeUnit: pricingInput.labourChargeUnit,
        labourWeightBasis: pricingInput.labourWeightBasis,
        itemCode: 'GR10286',
        tagIdentifiers: ['GR10286'],
      }), 2);
      sameFigures(pricing, card, label);
      // A request with no labour figure charges the item's the same way.
      near((await priced({ netWt: 10, purityKarat: '22K', itemCode: 'GR10286' }, 2)).breakdown.labourAmount, labour,
        `${label}: no labour sent`);
    }
  }
});

// ── 2, 10(2): a tag's "12%" labour ───────────────────────────────────────

test('2/10 a tag\'s "12%" labour: the current app sends 12 Percent, and the card prices what the analysis did', async () => {
  resetState();
  state.labour = { chargeType: 'AMOUNT', value: 500, rupeesUnit: 'Per Gram', weightBasis: 'net' };
  const reading = { netWeight: field('10'), grossWeight: field('12'), karat: field('22K'), labour: field('12%') };
  const { pricing } = await analyzePrice(reading, 2);
  near(pricing.breakdown.labourAmount, 17587.2, 'analysis labour');
  const card = await priced(appPayload({ labourChargeAmount: '12', labourChargeUnit: 'Percent' }), 2);
  sameFigures(pricing, card, '12% tag');
  assert.equal(card.finalMRPRounded, 164147);

  // A shop on PERCENTAGE labour: the tag's 12%, not the shop's 8%.
  state.labour = { chargeType: 'PERCENTAGE', value: 8, weightBasis: 'net' };
  const percentShop = await analyzePrice(reading, 2);
  near(percentShop.pricing.breakdown.labourAmount, 17587.2, 'the tag\'s percent');
});

test('2/10 a build in shops files "12%" as a purity and prefills the shop\'s 500/g: its first price is that', async () => {
  resetState();
  state.labour = { chargeType: 'AMOUNT', value: 500, rupeesUnit: 'Per Gram', weightBasis: 'net' };
  const { pricingInput, pricing } = await analyzePrice(
    { netWeight: field('10'), grossWeight: field('12'), karat: field('22K'), labour: field('12%') }, 1,
  );
  assert.equal(pricingInput.labourChargeAmount, '500');
  const card = await priced(appPayload({ labourChargeAmount: '500' }), 1);
  sameFigures(pricing, card, 'rules 1');
  assert.equal(card.finalMRPRounded, 151560);
});

// ── 3, 10(3): gram stones and packet-code colour stones ──────────────────

test('3/10 a 0.40 g colour stone: the current app sends unit "g", so the card prices 2 ct as the analysis does', async () => {
  resetState();
  const { pricingInput, pricing } = await analyzePrice({
    netWeight: field('10'), grossWeight: field('12'), karat: field('22K'),
    colorstones: [{ weight: field('0.40 g'), rate: field('2000') }],
  }, 2);
  assert.deepEqual(pricingInput.colorstones, [{ weight: 0.4, rate: 2000, unit: 'g' }]);
  near(pricing.breakdown.colorstoneAmount, 4000, 'analysis');
  const card = await priced(appPayload({ colorstones: [{ weight: 0.4, rate: 2000, unit: 'g' }] }), 2);
  sameFigures(pricing, card, 'gram stone');
});

test('3/10 a colour stone from packet EM-B: the app looks the row up by the tag\'s packet code, as the analysis does', async () => {
  resetState();
  state.colorstoneRows = [
    { packetCode: 'EM-B', color: '', clarity: '', rate: 20000 },
    { packetCode: '', color: 'RED', clarity: 'SI', rate: 1200 },
  ];
  const reading = {
    netWeight: field('5'), grossWeight: field('6'), karat: field('18K'), packetCode: field('EM-B'),
    colorstones: [{ weight: field('1.2'), color: field(''), clarity: field(''), rate: field('') }],
  };
  const { pricingInput, pricing } = await analyzePrice(reading, 2);
  assert.deepEqual(pricingInput.colorstones, [{ weight: 1.2, rate: 20000, unit: 'ct' }]);
  near(pricing.breakdown.colorstoneAmount, 24000, 'analysis');
  // The card's row carries the rate its packet lookup found.
  const card = await priced(appPayload({
    netWt: 5, grossWt: 6, purityKarat: '18K', colorstones: [{ weight: 1.2, rate: 20000, unit: 'ct' }],
  }), 2);
  sameFigures(pricing, card, 'packet row');
});

test('3/10 a build in shops sends carats and its colour/clarity lookup: its first price is what its card asks for', async () => {
  resetState();
  state.colorstoneRows = [
    { packetCode: 'EM-B', color: '', clarity: '', rate: 20000 },
    { packetCode: '', color: 'RED', clarity: 'SI', rate: 1200 },
  ];
  const { pricingInput, pricing } = await analyzePrice({
    netWeight: field('5'), grossWeight: field('6'), karat: field('18K'), packetCode: field('EM-B'),
    colorstones: [
      { weight: field('0.40 g'), color: field(''), clarity: field(''), rate: field('2000') },
      { weight: field('0.2'), color: field('red'), clarity: field('si'), rate: field('900') },
      { weight: field('0.3'), color: field('BLUE'), clarity: field('VS'), rate: field('700') },
    ],
  }, 1);
  // Carats (no unit), the printed rate without both a colour and a clarity,
  // the RED SI row for the second, and a miss clears the third's rate.
  assert.deepEqual(pricingInput.colorstones, [
    { weight: 0.4, rate: 2000, unit: 'ct' },
    { weight: 0.2, rate: 1200, unit: 'ct' },
    { weight: 0.3, rate: 0, unit: 'ct' },
  ]);
  const card = await priced(appPayload({
    netWt: 5, grossWt: 6, purityKarat: '18K',
    colorstones: [{ weight: 0.4, rate: 2000 }, { weight: 0.2, rate: 1200 }, { weight: 0.3, rate: 0 }],
  }), 1);
  sameFigures(pricing, card, 'rules 1 stones');
});

// ── 9: the builds in shops keep the exact item code ──────────────────────

test('9 a build in shops sending GR10286 is charged no prefix item wastage (its invoice has no wastage line)', async () => {
  resetState();
  state.itemRows = [{ code: 'GR', wastage: 8, labour: null }];
  const legacy = await priced({ netWt: 10, purityKarat: '22K', itemCode: 'GR10286', tagIdentifiers: ['GR10286'] }, 1);
  assert.equal(legacy.breakdown.wastageAmount, 0);
  assert.equal(legacy.finalMRPRounded, 146560);
  // The item picked by its exact code is charged, as it always was.
  near((await priced({ netWt: 10, purityKarat: '22K', itemCode: 'GR' }, 1)).breakdown.wastageAmount, 12800, 'exact code');
  // The current app (which bills a wastage line) is charged the prefix item's 8%.
  const current = await priced({ netWt: 10, purityKarat: '22K', itemCode: 'GR10286', tagIdentifiers: ['GR10286'] }, 2);
  near(current.breakdown.wastageAmount, 12800, 'rules 2');
  assert.equal(current.finalMRPRounded, 159360);
  // And the analysis for each build agrees with that build.
  const analysisLegacy = await analyzePrice({ serialNumber: field('GR10286'), netWeight: field('10'), karat: field('22K') }, 1);
  assert.equal(analysisLegacy.pricing.breakdown.wastageAmount, 0);
  const analysisCurrent = await analyzePrice({ serialNumber: field('GR10286'), netWeight: field('10'), karat: field('22K') }, 2);
  near(analysisCurrent.pricing.breakdown.wastageAmount, 12800, 'analysis rules 2');
});

// ── 6: labour text /calculate used to refuse ─────────────────────────────

test('6 labour text "MC 850" is Rs 850/g on /calculate as in the analysis; "NIL" leaves the shop\'s charge', async () => {
  resetState();
  for (const rules of [1, 2]) {
    const { pricing } = await analyzePrice(
      { netWeight: field('10'), grossWeight: field('12'), karat: field('22K'), labour: field('MC 850') }, rules,
    );
    near(pricing.breakdown.labourAmount, 8500, `analysis rules ${rules}`);
    // What a build in shops forwards: the text as it stands.
    const card = await priced(appPayload({ labourChargeAmount: 'MC 850' }), rules);
    sameFigures(pricing, card, `MC 850 rules ${rules}`);
  }
  for (const [text, labour, unit] of [
    ['Making 850', 8500, 'Per Gram'],
    ['850 per 10 gram', 850, 'Per 10 Gram'],
    ['LBR 12%', 17587.2, 'Percent'],
    ['Rs. 650', 6500, 'Per Gram'],
  ]) {
    const data = await priced({ netWt: 10, purityKarat: '22K', labourChargeAmount: text }, 2);
    near(data.breakdown.labourAmount, labour, text);
    assert.ok(data.breakdown.labourChargeType.endsWith('_MANUAL'), unit);
  }

  state.labour = { chargeType: 'AMOUNT', value: 500, rupeesUnit: 'Per Gram', weightBasis: 'net' };
  const nil = await priced(appPayload({ labourChargeAmount: 'NIL' }), 1);
  near(nil.breakdown.labourAmount, 5000, 'NIL: the shop\'s charge');
  const nilAnalysis = await analyzePrice(
    { netWeight: field('10'), grossWeight: field('12'), karat: field('22K'), labour: field('NIL') }, 1,
  );
  sameFigures(nilAnalysis.pricing, nil, 'NIL');
  // A plain negative or an over-100 percent is still refused.
  assert.equal((await calculate({ netWt: 10, purityKarat: '22K', labourChargeAmount: '-500' }, 2)).statusCode, 400);
  assert.equal((await calculate({ netWt: 10, purityKarat: '22K', labourChargeAmount: 'LBR 150%' }, 2)).statusCode, 400);
});

// ── 5: one karat table ───────────────────────────────────────────────────

test('5 the server reads exactly the karats and finenesses the app reads (no 15K / 625 on either side)', () => {
  const numbers = [...SCANNABLE_KARAT_NUMBERS].sort((a, b) => b - a);
  assert.deepEqual(numbers, ['24', '23', '22', '21', '20', '18', '14', '10', '9']);
  assert.ok(!FINENESS_STANDARDS.some(([perMille]) => perMille === 625));

  // Held to the app's own tables when the app's source sits beside this repo.
  const appFile = path.join(__dirname, '..', '..', 'mrpscan-app', 'frontend', 'utils', 'formulaUtils.ts');
  if (!fs.existsSync(appFile)) return;
  const source = fs.readFileSync(appFile, 'utf8');
  const scannable = source.match(/export const SCANNABLE_KARATS = \[([^\]]*)\]/);
  assert.ok(scannable, 'SCANNABLE_KARATS in formulaUtils.ts');
  const appKarats = [...scannable[1].matchAll(/'(\d+)K'/g)].map((match) => match[1]);
  assert.deepEqual([...appKarats].sort((a, b) => b - a), numbers);
  const fineness = source.match(/const FINENESS_STANDARDS[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(fineness, 'FINENESS_STANDARDS in formulaUtils.ts');
  const appFineness = [...fineness[1].matchAll(/\[(\d+),\s*'(\d+K)'\]/g)].map((match) => [Number(match[1]), match[2]]);
  assert.deepEqual(appFineness, FINENESS_STANDARDS);
});

// ── 4: a blank net weight on the invoice ─────────────────────────────────

test('4 an invoice gold line with an amount and no weight is refused, not registered as 1 GMS', () => {
  const gold = (qty) => ({
    description: 'Gold (in grams)', qty, qty_unit: 'g', hsn: '71131913', price: 0, amount: 98928,
  });
  assert.throws(
    () => computeInvoiceFigures({ lineItems: [gold(0)], gstRate: 3, intraState: true }),
    (error) => error instanceof InvoiceInputError && /no weight in grams/.test(error.message),
  );
  const stone = { description: 'Diamond (in carats)', qty: 0, qty_unit: 'Ct', hsn: '71131913', price: 0, amount: 5000 };
  assert.throws(
    () => computeInvoiceFigures({ lineItems: [gold(6.75), stone], gstRate: 3, intraState: true }),
    (error) => error instanceof InvoiceInputError && /no weight in carats/.test(error.message),
  );
  // The weight the piece was priced on (netWeightUsed) bills as it should.
  const figures = computeInvoiceFigures({ lineItems: [gold(6.75)], gstRate: 3, intraState: true });
  assert.equal(figures.lines[0].uqc, 'GMS');
  assert.equal(figures.lines[0].billedQty, 6.75);
  // Labour and charges still bill by amount alone.
  const labour = { description: 'Labour Charge', qty: 0, qty_unit: '', hsn: '71131913', price: 0, amount: 5000 };
  assert.equal(computeInvoiceFigures({ lineItems: [gold(6.75), labour], gstRate: 3, intraState: true }).lines[1].uqc, 'OTH');
});

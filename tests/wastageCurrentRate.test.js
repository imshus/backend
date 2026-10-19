/**
 * Wastage at the current gold rate (pricing rules 3): the shop's percent of
 * the net or the gross weight (the Wastage tile's Weight Used) priced at the
 * rate the Gold tile shows as Current Gold Rate, the 24K rate after the
 * piece's purity, per gram:
 *
 *   wastage = percent / 100 x weight x (24K rate per 10 g / 10 x purity)
 *
 * 22K (91.6%) at 1,50,000 a 10 g is 13,740 a gram, so 8% of a 10 g net
 * weight is 0.8 g x 13,740 = 10,992 and of a 10.5 g gross weight 0.84 g x
 * 13,740 = 11,541.60. The amount is in the MRP, and the invoice's wastage
 * line bills it: the grams to the milligram, at that rate where they come
 * to the line's rupees, else at the price that does, with no discount
 * either way. Builds on rules 1 and 2 keep the net weight at the 24K rate,
 * which their invoices print.
 *
 * pricingMath, the controller, computeMrp and deriveInputFromReading are the
 * real ones; the database and the live rates are stood in for.
 */
process.env.USE_MEMORY_STORE = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

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
const { computePricing } = require('../src/services/pricingMath');
const {
  validateCalculationInput,
  CURRENT_PRICING_RULES,
  WASTAGE_AT_GOLD_RATE_RULES,
} = require('../src/services/pricingInputs');
const { computeInvoiceFigures } = require('../src/services/invoiceMath');
const { roundHalfUp } = require('../src/utils/money');

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
    rtgs: 150000,
    labour: { chargeType: 'NONE', value: 0 },
    itemRows: [],
    wastageRows: [],
    labourCodeRows: [],
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
// No labour codes saved unless a test saves some: the labour is priced
// exactly as before them.
LabourCode.find = shopRows('labourCodeRows');
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

/** POST /scans/scan-1/calculate through the real controller; rules 1 sends no header. */
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

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message || 'value'}: ${actual} is not ${expected}`);

/** computePricing for a plain gold piece: 10 g net, 10.5 g gross, 8% wastage, 1,50,000 a 10 g. */
const pricePiece = (overrides) => computePricing({
  netWt: 10,
  grossWt: 10.5,
  customPurityPercent: null,
  karatPurityPercent: 91.6,
  karatNumber: 22,
  goldRatePer10g: 150000,
  diamonds: [],
  colorstones: [],
  labourRatePerUnit: 0,
  labourUnit: 'Per Gram',
  labourWeightBasis: 'net',
  wastagePercent: 8,
  wastageWeightBasis: 'net',
  wastageAtCurrentGoldRate: true,
  otherCharges: 0,
  labourChargeType: 'NONE',
  wastageCode: '',
  ...overrides,
});

const wastageOf = (result) => {
  const b = result.breakdown;
  return { basis: b.wastageWeightBasis, grams: b.wastageWeightGrams, rate: b.wastageRatePerGram, amount: b.wastageAmount };
};

const expectWastage = (result, { basis, grams, rate, amount }, label) => {
  const got = wastageOf(result);
  assert.equal(got.basis, basis, `${label}: basis`);
  near(got.grams, grams, `${label}: grams`);
  near(got.rate, rate, `${label}: rate per gram`);
  near(got.amount, amount, `${label}: amount`);
  // The grams at the rate they were priced at are the amount.
  near(got.grams * got.rate, got.amount, `${label}: grams x rate`);
};

// ── The arithmetic (pricingMath) ─────────────────────────────────────────

test('the current pricing rules are 4; wastage at the current gold rate came in with 3', () => {
  assert.equal(CURRENT_PRICING_RULES, 4);
  assert.equal(WASTAGE_AT_GOLD_RATE_RULES, 3);
});

test('22K: 8% of the net or the gross weight at the current gold rate (24K x 91.6%)', () => {
  expectWastage(pricePiece({ wastageWeightBasis: 'net' }), { basis: 'net', grams: 0.8, rate: 13740, amount: 10992 }, '22K net');
  expectWastage(
    pricePiece({ wastageWeightBasis: 'gross' }),
    { basis: 'gross', grams: 0.84, rate: 13740, amount: 11541.6 },
    '22K gross',
  );
});

test('18K: the rate is the 24K rate at 75%', () => {
  const k18 = { karatPurityPercent: 75, karatNumber: 18 };
  expectWastage(pricePiece({ ...k18, wastageWeightBasis: 'net' }), { basis: 'net', grams: 0.8, rate: 11250, amount: 9000 }, '18K net');
  expectWastage(
    pricePiece({ ...k18, wastageWeightBasis: 'gross' }),
    { basis: 'gross', grams: 0.84, rate: 11250, amount: 9450 },
    '18K gross',
  );
});

test('a custom purity sets the rate, as it sets the Gold tile\'s current gold rate', () => {
  // 22K tag, purity typed as 80%: 15,000 x 80% = 12,000 a gram.
  const custom = { customPurityPercent: 80 };
  expectWastage(pricePiece({ ...custom, wastageWeightBasis: 'net' }), { basis: 'net', grams: 0.8, rate: 12000, amount: 9600 }, 'custom net');
  expectWastage(
    pricePiece({ ...custom, wastageWeightBasis: 'gross' }),
    { basis: 'gross', grams: 0.84, rate: 12000, amount: 10080 },
    'custom gross',
  );
  // The rate is the gold line's own: the gold amount is the net weight at it.
  const result = pricePiece({ ...custom });
  near(result.breakdown.goldAmount, 10 * result.breakdown.wastageRatePerGram, 'gold at the same rate');
});

test('gross with no gross weight falls back to the net weight, and says so', () => {
  expectWastage(
    pricePiece({ grossWt: 0, wastageWeightBasis: 'gross' }),
    { basis: 'net', grams: 0.8, rate: 13740, amount: 10992 },
    'no gross weight',
  );
});

test('a gross basis on a tag with only a gross weight takes that gross weight', () => {
  // Net worked out from the gross (no stones): 10.5 g either way.
  const result = pricePiece({ netWt: 0, grossWt: 10.5, wastageWeightBasis: 'gross' });
  assert.equal(result.breakdown.netWeightEstimated, true);
  expectWastage(result, { basis: 'gross', grams: 0.84, rate: 13740, amount: 11541.6 }, 'gross only');
});

test('the MRP carries the new wastage amount', () => {
  const net = pricePiece({ wastageWeightBasis: 'net' });
  // Gold 10 g x 91.6% x 15,000 = 1,37,400; with 10,992 of wastage 1,48,392.
  near(net.breakdown.goldAmount, 137400, 'gold');
  near(net.finalMRP, 137400 + 10992, 'net MRP');
  assert.equal(net.finalMRPRounded, 148392);
  near(net.breakdown.subtotal, net.breakdown.goldAmount + net.breakdown.wastageAmount, 'subtotal');

  const gross = pricePiece({ wastageWeightBasis: 'gross', labourRatePerUnit: 500 });
  // 1,37,400 + 5,000 labour + 11,541.60 = 1,53,941.60 -> 1,53,942.
  near(gross.finalMRP, 153941.6, 'gross MRP');
  assert.equal(gross.finalMRPRounded, 153942);
});

test('rules 1-2 keep today\'s wastage: the net weight at the 24K rate, whatever basis is asked', () => {
  for (const basis of ['net', 'gross', undefined]) {
    const result = pricePiece({ wastageAtCurrentGoldRate: false, wastageWeightBasis: basis });
    expectWastage(result, { basis: 'net', grams: 0.8, rate: 15000, amount: 12000 }, `rules 2, ${basis}`);
    assert.equal(result.finalMRPRounded, 149400);
  }
  // Left out, the flag is rules 1-2.
  const defaulted = computePricing({
    netWt: 10, grossWt: 10.5, customPurityPercent: null, karatPurityPercent: 91.6, karatNumber: 22,
    goldRatePer10g: 150000, diamonds: [], colorstones: [], labourRatePerUnit: 0, labourUnit: 'Per Gram',
    labourWeightBasis: 'net', wastagePercent: 8, otherCharges: 0, labourChargeType: 'NONE', wastageCode: '',
  });
  expectWastage(defaulted, { basis: 'net', grams: 0.8, rate: 15000, amount: 12000 }, 'no flag');
});

test('no wastage percent is no wastage, at any basis', () => {
  for (const basis of ['net', 'gross']) {
    const { amount, grams } = wastageOf(pricePiece({ wastagePercent: 0, wastageWeightBasis: basis }));
    assert.equal(grams, 0);
    assert.equal(amount, 0);
  }
});

// ── The request ──────────────────────────────────────────────────────────

test('wastageWeightBasis reads net or gross in any case, and nothing when blank', () => {
  assert.equal(validateCalculationInput({ wastageWeightBasis: 'gross' }).wastageWeightBasis, 'gross');
  assert.equal(validateCalculationInput({ wastageWeightBasis: ' Net ' }).wastageWeightBasis, 'net');
  assert.equal(validateCalculationInput({ wastageWeightBasis: 'GROSS' }).wastageWeightBasis, 'gross');
  for (const blank of [undefined, null, '', '  ']) {
    assert.equal(validateCalculationInput({ wastageWeightBasis: blank }).wastageWeightBasis, null);
  }
});

test('a wastageWeightBasis that is not net or gross is a 400 naming the field, on every build', async () => {
  resetState();
  for (const bad of ['both', 'netto', 'pure', 5, true, ['gross'], { basis: 'gross' }]) {
    for (const rules of [1, 2, 3, 4]) {
      const res = await calculate({ netWt: 10, purityKarat: '22K', wastagePercent: 8, wastageWeightBasis: bad }, rules);
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} on rules ${rules}`);
      assert.equal(res.body.error, 'INVALID_PRICING_INPUT');
      assert.match(res.body.message, /wastageWeightBasis must be "net" or "gross"/);
    }
  }
});

// ── Through /calculate ───────────────────────────────────────────────────

const PIECE = { jewelleryType: 'GOLD', netWt: 10, grossWt: 10.5, purityKarat: '22K', calculationMode: 'rtgs' };

test('rules 3: the card\'s 8% on net or gross is priced at the current gold rate', async () => {
  resetState();
  const net = await priced({ ...PIECE, wastagePercent: 8, wastageWeightBasis: 'net' }, 3);
  expectWastage(net, { basis: 'net', grams: 0.8, rate: 13740, amount: 10992 }, 'rules 3 net');
  assert.equal(net.finalMRPRounded, 148392);

  const gross = await priced({ ...PIECE, wastagePercent: 8, wastageWeightBasis: 'gross' }, 3);
  expectWastage(gross, { basis: 'gross', grams: 0.84, rate: 13740, amount: 11541.6 }, 'rules 3 gross');
  assert.equal(gross.finalMRPRounded, 148942);

  // No basis sent is net.
  const unsent = await priced({ ...PIECE, wastagePercent: 8 }, 3);
  expectWastage(unsent, { basis: 'net', grams: 0.8, rate: 13740, amount: 10992 }, 'rules 3 unsent');

  // The rate moves with the board: 1,60,000 a 10 g is 14,656 a gram of 22K.
  state.rtgs = 160000;
  const dearer = await priced({ ...PIECE, wastagePercent: 8, wastageWeightBasis: 'gross' }, 3);
  expectWastage(dearer, { basis: 'gross', grams: 0.84, rate: 14656, amount: 12311.04 }, 'rules 3 at 1,60,000');
});

test('rules 3: a Masters item\'s wastage on the tag number is priced the same way', async () => {
  resetState();
  state.itemRows = [{ code: 'GR', wastage: 8, labour: null }];
  const net = await priced({ ...PIECE, itemCode: 'GR10286', tagIdentifiers: ['GR10286'] }, 3);
  expectWastage(net, { basis: 'net', grams: 0.8, rate: 13740, amount: 10992 }, 'item net');
  const gross = await priced({ ...PIECE, itemCode: 'GR10286', tagIdentifiers: ['GR10286'], wastageWeightBasis: 'gross' }, 3);
  expectWastage(gross, { basis: 'gross', grams: 0.84, rate: 13740, amount: 11541.6 }, 'item gross');

  // And a Masters -> Wastage code's percent.
  state.itemRows = [];
  state.wastageRows = [{ code: 'W8', percent: 8 }];
  const coded = await priced({ ...PIECE, grossWt: 12, tagIdentifiers: ['W8'], wastageWeightBasis: 'gross' }, 3);
  assert.equal(coded.breakdown.wastageCode, 'W8');
  expectWastage(coded, { basis: 'gross', grams: 0.96, rate: 13740, amount: 13190.4 }, 'wastage code gross');
});

test("a wastage code picked on the card is priced and recorded ahead of the tag's own", async () => {
  resetState();
  state.wastageRows = [{ code: 'W8', percent: 8 }, { code: 'W10', percent: 10 }];

  // The tag names W8; the card picked W10, so W10's percent is charged.
  const picked = await priced({ ...PIECE, tagIdentifiers: ['W8'], wastageCode: 'W10' }, 3);
  assert.equal(picked.breakdown.wastageCode, 'W10');
  expectWastage(picked, { basis: 'net', grams: 1, rate: 13740, amount: 13740 }, 'picked W10');

  // Picked on a tag with no identifiers at all.
  const alone = await priced({ ...PIECE, wastageCode: 'w 10' }, 3);
  assert.equal(alone.breakdown.wastageCode, 'W10');
  expectWastage(alone, { basis: 'net', grams: 1, rate: 13740, amount: 13740 }, 'picked alone');

  // A typed percent still beats the code's; the code is still recorded.
  const typed = await priced({ ...PIECE, tagIdentifiers: ['W8'], wastageCode: 'W10', wastagePercent: 8 }, 3);
  assert.equal(typed.breakdown.wastageCode, 'W10');
  expectWastage(typed, { basis: 'net', grams: 0.8, rate: 13740, amount: 10992 }, 'typed beats picked');

  // A picked code no longer in Masters gives way to the tag's own.
  const gone = await priced({ ...PIECE, tagIdentifiers: ['W8'], wastageCode: 'W99' }, 3);
  assert.equal(gone.breakdown.wastageCode, 'W8');

  assert.equal(validateCalculationInput({ ...PIECE, wastageCode: '  W10 ' }).wastageCode, 'W10');
  assert.equal(validateCalculationInput({ ...PIECE }).wastageCode, '');
  assert.throws(() => validateCalculationInput({ ...PIECE, wastageCode: { code: 'W10' } }), /wastageCode must be text/);
});

test('rules 2 and 1 price exactly as before: the net weight at the 24K rate', async () => {
  resetState();
  for (const basis of ['net', 'gross']) {
    const current = await priced({ ...PIECE, wastagePercent: 8, wastageWeightBasis: basis }, 2);
    expectWastage(current, { basis: 'net', grams: 0.8, rate: 15000, amount: 12000 }, `rules 2 ${basis}`);
    assert.equal(current.finalMRPRounded, 149400);
  }
  // 1.0.367 sends no basis at all.
  const sent = await priced({ ...PIECE, wastagePercent: 8 }, 2);
  near(sent.breakdown.wastageAmount, 12000, 'rules 2 as 1.0.367 sends it');
  // The builds in shops, on the item named exactly.
  state.itemRows = [{ code: 'GR', wastage: 8, labour: null }];
  const legacy = await priced({ ...PIECE, itemCode: 'GR' }, 1);
  expectWastage(legacy, { basis: 'net', grams: 0.8, rate: 15000, amount: 12000 }, 'rules 1');
});

test('rules 2 keeps its prefix item and its item labour now the current rules are 3', async () => {
  resetState();
  state.itemRows = [{ code: 'GR', wastage: 8, labour: 700 }];
  const body = { ...PIECE, itemCode: 'GR10286', tagIdentifiers: ['GR10286'] };
  const two = await priced(body, 2);
  near(two.breakdown.wastageAmount, 12000, 'rules 2 prefix item wastage');
  near(two.breakdown.labourAmount, 7000, 'rules 2 item labour');
  const one = await priced(body, 1);
  assert.equal(one.breakdown.wastageAmount, 0, 'rules 1 finds no item by prefix');
  assert.equal(one.breakdown.labourAmount, 0, 'rules 1 charges no item labour');
});

// ── The analysis's own price ─────────────────────────────────────────────

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

test('the analysis prices rules 3 as the card opens (net) and rules 2 as before', async () => {
  resetState();
  state.itemRows = [{ code: 'GR', wastage: 8, labour: null }];
  const reading = { serialNumber: field('GR10286'), netWeight: field('10'), grossWeight: field('10.5'), karat: field('22K') };

  const three = await analyzePrice(reading, 3);
  assert.equal(three.pricingInput.wastageWeightBasis, 'net');
  expectWastage(three.pricing, { basis: 'net', grams: 0.8, rate: 13740, amount: 10992 }, 'analysis rules 3');
  // The card's first body (net) is priced to the same figures.
  const card = await priced({
    ...PIECE, labourWeightBasis: 'net', otherCharges: 0, diamonds: [], colorstones: [],
    itemCode: 'GR10286', tagIdentifiers: ['GR10286'], wastageWeightBasis: 'net',
  }, 3);
  assert.equal(card.finalMRP, three.pricing.finalMRP);
  assert.equal(card.finalMRPRounded, three.pricing.finalMRPRounded);

  const two = await analyzePrice(reading, 2);
  assert.equal('wastageWeightBasis' in two.pricingInput, false, 'rules 2 input as before');
  expectWastage(two.pricing, { basis: 'net', grams: 0.8, rate: 15000, amount: 12000 }, 'analysis rules 2');
});

test('rules 4 prices every card and opens every reading as rules 3 when the tag names no labour code', async () => {
  resetState();
  // A shop with everything rules 3 prices: an item with wastage and labour,
  // wastage codes, a labour code (on no tag below), a gross-basis labour
  // charge and stone rate rows.
  state.labour = { chargeType: 'AMOUNT', value: 650, rupeesUnit: 'Per Gram', weightBasis: 'gross' };
  state.itemRows = [{ code: 'GR', wastage: 8, labour: 700 }, { code: 'BR', wastage: 6, labour: null }];
  state.wastageRows = [{ code: 'W8', percent: 8 }, { code: 'W10', percent: 10 }];
  state.labourCodeRows = [{ code: 'LB-01', rate: 415, unit: 'Per Gram' }];
  state.diamondRows = [{ packetCode: 'PK1', color: '', clarity: '', shape: '', rate: 60000 }];
  state.colorstoneRows = [{ packetCode: '', color: 'RED', clarity: 'SI', rate: 1200 }];

  const stones = {
    diamonds: [{ weight: 0.5, rate: 50000, discountPercent: 10, unit: 'ct' }],
    colorstones: [{ weight: 0.4, rate: 1000, unit: 'g' }],
  };
  const bodies = [
    { ...PIECE, wastagePercent: 8, wastageWeightBasis: 'gross' },
    { ...PIECE, wastagePercent: 8 },
    { ...PIECE, itemCode: 'GR10286', tagIdentifiers: ['GR10286'], wastageWeightBasis: 'gross' },
    { ...PIECE, itemCode: 'BR22', tagIdentifiers: ['BR22', 'W8'] },
    { ...PIECE, tagIdentifiers: ['W8'], wastageCode: 'W10' },
    { ...PIECE, labourChargeAmount: '12%' },
    { ...PIECE, labourChargeAmount: '850', labourChargeUnit: 'Per 10 Gram', labourWeightBasis: 'gross' },
    { ...PIECE, labourCode: 'LB-01' },
    { ...PIECE, tagIdentifiers: ['LB-01'], labourChargeAmount: '500' },
    { ...PIECE, ...stones, customPurityPercent: 90, otherCharges: 250, calculationMode: 'cash' },
  ];
  for (const body of bodies) {
    assert.deepEqual(await priced(body, 4), await priced(body, 3), JSON.stringify(body));
  }

  const base = { netWeight: field('10'), grossWeight: field('10.5'), karat: field('22K') };
  const readings = [
    { ...base, serialNumber: field('GR10286') },
    { ...base, serialNumber: field('GR10286'), labour: field('12%') },
    { ...base, serialNumber: field('GR10286'), labour: field('850|Per 10 Gram') },
    { ...base, serialNumber: field('BR22') },
    { ...base, serialNumber: field('261440') },
    {
      ...base,
      serialNumber: field('261440'),
      packetCode: field('PK1'),
      diamonds: [{ weight: field('0.50'), rate: field('50000') }],
      colorstones: [{ weight: field('0.40 g'), color: field('RED'), clarity: field('SI'), rate: field('900') }],
    },
  ];
  for (const shop of [state.labour, { chargeType: 'PERCENTAGE', value: 8, weightBasis: 'net' }, { chargeType: 'NONE', value: 0 }]) {
    state.labour = shop;
    for (const reading of readings) {
      const four = await analyzePrice(reading, 4);
      const three = await analyzePrice(reading, 3);
      assert.deepEqual(four.pricingInput, three.pricingInput, `input ${JSON.stringify({ shop, reading })}`);
      assert.deepEqual(four.pricing, three.pricing, `price ${JSON.stringify({ shop, reading })}`);
    }
  }
});

// ── The invoice ──────────────────────────────────────────────────────────

/**
 * The gold and wastage lines of the invoice request the rules-3 app sends
 * for a price (utils/moneyMath.ts buildInvoiceLines, invoice-sheet.tsx):
 * grams to the milligram, and whole rupees that add up to the MRP to the
 * rupee. The rupees and the wastage prices below are the ones the app's
 * own buildInvoiceLines gives for these scans.
 */
const appInvoiceLines = ({ goldGrams, goldRupees, wastageGrams, wastagePrice, wastageRupees }) => [
  { description: 'Gold (in grams)', qty: goldGrams, qty_unit: 'Gms.', hsn: '71131913', price: 13740, amount: goldRupees },
  { description: 'Wastage (in grams)', qty: wastageGrams, qty_unit: 'Gms.', hsn: '71131913', price: wastagePrice, amount: wastageRupees },
];
const invoiceOf = (lineItems) => computeInvoiceFigures({ lineItems, gstRate: 3, intraState: true });
const withWastagePrice = (lines, price) => lines.map((line, i) => (i === 1 ? { ...line, price } : line));

test('the invoice\'s wastage line on whole milligrams prints the current gold rate and bills the MRP', async () => {
  resetState();
  const data = await priced({ ...PIECE, wastagePercent: 8, wastageWeightBasis: 'gross' }, 3);
  const b = data.breakdown;
  // 0.84 g is whole milligrams, and 0.84 g at 13,740 (11,541.60) rounds to
  // the 11,542 the line bills (the MRP's 1,48,941.60 to the rupee), so the
  // app prints the rate itself.
  const rate = roundHalfUp(b.wastageRatePerGram, 2);
  assert.equal(rate, 13740);
  assert.equal(roundHalfUp(b.wastageWeightGrams, 3), 0.84);
  assert.equal(roundHalfUp(0.84 * rate), 11542);
  assert.equal(data.finalMRPRounded, 137400 + 11542);

  const lines = appInvoiceLines({ goldGrams: 10, goldRupees: 137400, wastageGrams: 0.84, wastagePrice: rate, wastageRupees: 11542 });
  const figures = invoiceOf(lines);
  const wastage = figures.lines[1];
  assert.equal(wastage.kind, 'wastage');
  assert.equal(wastage.uqc, 'GMS');
  assert.equal(wastage.qty, 0.84);
  assert.equal(wastage.price, 13740, 'the rate printed');
  assert.equal(wastage.amountPaise, 1154200);
  assert.equal(wastage.discountPaise, 0, 'no discount registered');
  // The e-invoice registers the rupees billed over the grams: the 40 paise
  // the line's rounding added sit in its unit price, not in a discount.
  assert.equal(wastage.unitPrice, 13740.476);
  // The subtotal is the MRP the card quoted.
  assert.equal(figures.subtotalPaise, data.finalMRPRounded * 100);

  // Printed at the 24K rate (as the builds before rules 3 print it), the
  // same line would register 0.84 g x 15,000 less 11,542 = 1,058 of
  // discount: why the rate is in the breakdown.
  assert.equal(invoiceOf(withWastagePrice(lines, b.goldRateApplied)).lines[1].discountPaise, 105800);
});

test('wastage grams are taken to the milligram, so the invoice line prints the Current Gold Rate', async () => {
  resetState();
  const plain = { jewelleryType: 'GOLD', purityKarat: '22K', calculationMode: 'rtgs', wastagePercent: 8 };

  // 8% of 8.765 g is 0.7012 g; priced as the invoice prints it, 0.701 g at
  // 13,740 is 9,631.74 (the owner's call: grams to the milligram first).
  const down = await priced({ ...plain, netWt: 8.765 }, 3);
  expectWastage(down, { basis: 'net', grams: 0.701, rate: 13740, amount: 9631.74 }, '8.765 g');
  assert.equal(down.finalMRPRounded, 130063);
  const downLines = appInvoiceLines({
    goldGrams: 8.765, goldRupees: 120431, wastageGrams: 0.701, wastagePrice: 13740, wastageRupees: 9632,
  });
  const downFigures = invoiceOf(downLines);
  assert.equal(downFigures.lines[1].qty, 0.701);
  assert.equal(downFigures.lines[1].discountPaise, 0);
  assert.equal(downFigures.subtotalPaise, down.finalMRPRounded * 100);

  // 8% of 8.769 g is 0.70152 g, priced as 0.702 g: 9,645.48. The MRP's odd
  // rupee (1,30,131.54 to 1,30,132) is the gold line's, so the wastage line
  // bills 9,645 at 13,740 and nothing reads as a discount.
  const up = await priced({ ...plain, netWt: 8.769 }, 3);
  expectWastage(up, { basis: 'net', grams: 0.702, rate: 13740, amount: 9645.48 }, '8.769 g');
  assert.equal(up.finalMRPRounded, 130132);
  const upLines = appInvoiceLines({
    goldGrams: 8.769, goldRupees: 120487, wastageGrams: 0.702, wastagePrice: 13740, wastageRupees: 9645,
  });
  const upFigures = invoiceOf(upLines);
  assert.equal(upFigures.lines[1].qty, 0.702);
  assert.equal(upFigures.lines[1].discountPaise, 0);
  assert.equal(upFigures.subtotalPaise, up.finalMRPRounded * 100);

  // Builds on rules 2 keep their unrounded grams.
  const old = await priced({ ...plain, netWt: 8.765 }, 2);
  near(wastageOf(old).grams, 0.7012, 'rules 2 grams');
});

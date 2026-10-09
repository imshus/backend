/**
 * POST /scans/:id/analyze prices the reading it returns, and starts the
 * price's reading-independent reads (prefetchPricingReads: rate tables, tax,
 * labour, wastage, employee, the live-rate warm-up) beside the model call.
 * The price must come out exactly as computing it after the reading does,
 * every read it needs must already be under way while the model reads, each
 * in the caller's own scope, and only the live rates are read a second time
 * (afterwards, so the price uses the board as it stands then).
 *
 * The analysis itself and the database are stood in for; the controller,
 * prefetchPricingReads, deriveInputFromReading and computeMrp are the real
 * ones.
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
const Employee = require('../src/models/employee.model');
const rateCalculationService = require('../src/services/rateCalculation.service');
const scanService = require('../src/services/scan.service');
const scanController = require('../src/controllers/scan.controller');
const { computeMrp, deriveInputFromReading } = require('../src/services/mrpCalculation.service');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => JSON.parse(JSON.stringify(value));

// Every lookup, in the order it was made. Each answers a little later, as a
// database would.
const lookups = [];
const answer = async (name, value) => {
  lookups.push(name);
  await sleep(5);
  return clone(value);
};

const original = {
  getLiveGoldRates: rateCalculationService.getLiveGoldRates,
  labourFindOne: LabourRate.findOne,
  taxFindOne: GoldTaxSetting.findOne,
  diamondFind: DiamondRate.find,
  colorstoneFind: ColorstoneRate.find,
  wastageFind: WastageCode.find,
  itemFind: ItemCode.find,
  employeeFindById: Employee.findById,
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
  Employee.findById = original.employeeFindById;
  scanService.analyzeScan = original.analyzeScan;
});

// The shop's settings, stored without a userId; employees inherit them.
const shopOnly = (name, value) => async (query) => answer(`${name}:${query.userId ?? 'shop'}`, query.userId ? null : value);
const shopRows = (name, rows) => async (query) => answer(`${name}:${query.userId ?? 'shop'}`, query.userId ? [] : rows);

rateCalculationService.getLiveGoldRates = async (businessId, scope) =>
  answer(`goldRates:${businessId}:${scope?.userId ?? 'shop'}`, {
    karatRates: [
      { carat: '22Kt', purity: 91.6 },
      { carat: '18Kt', purity: 75 },
    ],
    taxSettings: { rtgsFinalRate: 151807, cashFinalRate: 148357 },
  });
LabourRate.findOne = shopOnly('labour', { chargeType: 'AMOUNT', value: 650, rupeesUnit: 'Per Gram' });
GoldTaxSetting.findOne = shopOnly('tax', { scannerCalculationUse: 'cash' });
DiamondRate.find = shopRows('diamondRates', [
  { color: 'FG', clarity: 'SI', shape: 'PC', rate: 55000 },
  { color: 'EF', clarity: 'VVS', rate: 82000 },
]);
ColorstoneRate.find = shopRows('colorstoneRates', [{ color: 'RED', clarity: 'SI', rate: 1200 }]);
WastageCode.find = shopRows('wastageCodes', [{ code: 'GR10286', percent: 8 }]);
ItemCode.find = shopRows('itemCodes', []);
// A query: awaited directly by computeMrp, through .exec() by the prefetch.
Employee.findById = (id) => ({
  select: () => {
    const read = answer(`employee:${id}`, { permissions: { scan_rate_rtgs: false, scan_rate_cash: true } });
    return Object.assign(read, { exec: () => read });
  },
});

const BIZ = '507f1f77bcf86cd799439011';
const OWNER = { businessId: BIZ, userId: '507f1f77bcf86cd799439012', role: 'OWNER' };
const EMPLOYEE = { businessId: BIZ, userId: '507f1f77bcf86cd799439013', role: 'EMP' };

const scanFor = (user, analysisResult) => ({
  scanId: `scan-${user.role}`,
  status: 'ANALYSIS_COMPLETED',
  jewelleryType: 'DIAMOND',
  ownerUserId: user.userId,
  businessId: user.businessId,
  analysisResult,
  billing: { billed: false, pending: true },
});

const field = (value, confidence = 95) => ({ value, confidence });
const READING_WITH_CODES = {
  provider: 'openai',
  rawText: { merged: 'DIA WT .54 GR WT 8.208 NET WT 8.100 ST NO GR10286' },
  structuredData: {
    serialNumber: field('GR10286'),
    grossWeight: field('8.208'),
    netWeight: field('8.100'),
    karat: field('18K'),
    diamonds: [
      { weight: field('0.54'), color: field('FG'), clarity: field('SI'), shape: field('PC'), rate: field(''), packetCode: field('') },
    ],
    colorstones: [{ weight: field('0.20'), color: field('RED'), clarity: field('SI'), rate: field('') }],
  },
  unknownFields: [{ abbreviation: 'SR NO', detectedValue: '261440', confidence: 90 }],
  overallConfidence: 90,
};
// No identifier at all: the wastage codes are not consulted.
const READING_WITHOUT_CODES = {
  ...clone(READING_WITH_CODES),
  structuredData: { ...clone(READING_WITH_CODES.structuredData), serialNumber: field('') },
  unknownFields: [],
};

/** The analyze endpoint, with the analysis taking `readMs` and the record written. */
const analyzeThroughController = async (user, scan, readMs = 40) => {
  const events = [];
  let lookupsDuringRead = null;
  scanService.analyzeScan = async () => {
    await sleep(readMs);
    lookupsDuringRead = [...lookups];
    events.push('analysis-and-record-done');
    return clone(scan);
  };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      events.push('response');
      this.body = payload;
      return this;
    },
  };
  let failure = null;
  await scanController.analyzeScan(
    { params: { scanId: scan.scanId }, body: {}, user, licenseContext: null },
    res,
    (error) => {
      failure = error;
    },
  );
  assert.equal(failure, null);
  return { res, events, lookupsDuringRead };
};

/** The same price worked out the way it was before: every lookup after the reading. */
const priceAfterReading = async (user, scan) => {
  const pricingInput = await deriveInputFromReading({
    user,
    structuredData: scan.analysisResult.structuredData,
    scan,
  });
  const computed = await computeMrp({
    user,
    sessionContext: { userId: user.userId, businessId: user.businessId, role: user.role },
    scanId: scan.scanId,
    input: pricingInput,
    scan,
  });
  return { pricing: computed.resultData, pricingInput };
};

const countsOf = (names) => names.reduce((counts, name) => counts.set(name, (counts.get(name) || 0) + 1), new Map());

for (const [label, user, reading] of [
  ['the owner, a tag with a wastage code', OWNER, READING_WITH_CODES],
  ['an employee, a tag with a wastage code', EMPLOYEE, READING_WITH_CODES],
  ['the owner, a tag without any identifier', OWNER, READING_WITHOUT_CODES],
]) {
  test(`analyze prices exactly as before with the reads prefetched: ${label}`, async () => {
    const scan = scanFor(user, reading);

    lookups.length = 0;
    const { res, events, lookupsDuringRead } = await analyzeThroughController(user, scan);
    const overlapped = [...lookups];

    lookups.length = 0;
    const expected = await priceAfterReading(user, scan);
    const sequential = [...lookups];

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.data.pricing, 'the reading was priced');
    assert.deepEqual(res.body.data.pricing, expected.pricing);
    assert.deepEqual(res.body.data.pricingInput, expected.pricingInput);

    // Every lookup the price needs was already made while the model read.
    const needed = countsOf(sequential);
    for (const name of needed.keys()) {
      assert.ok(lookupsDuringRead.includes(name), `${name} ran during the read`);
    }
    // Nothing was looked up twice but the live rates, re-read once after the
    // reading (a cache hit on the current board in production); only the
    // wastage codes are fetched ahead for a tag that turns out to carry no
    // identifier.
    const made = countsOf(overlapped);
    for (const [name, times] of needed) {
      const expectedTimes = name.startsWith('goldRates:') ? times + 1 : times;
      assert.equal(made.get(name), expectedTimes, `${name} made ${expectedTimes} time(s)`);
    }
    const extra = [...made.keys()].filter((name) => !needed.has(name));
    assert.deepEqual(extra.filter((name) => !name.startsWith('wastageCodes:')), []);
    // The record is written before the response leaves.
    assert.deepEqual(events, ['analysis-and-record-done', 'response']);
  });
}

test('the cash/RTGS choice and the wastage come out of the prefetched reads', async () => {
  const scan = scanFor(OWNER, READING_WITH_CODES);
  const { res } = await analyzeThroughController(OWNER, scan);
  const { pricing, pricingInput } = res.body.data;
  // The shop's tax settings choose cash for scanner pricing.
  assert.equal(pricingInput.calculationMode, 'cash');
  assert.equal(pricing.breakdown.goldRateApplied, 148357 / 10);
  // The tag's number is a saved wastage code.
  assert.equal(pricing.breakdown.wastageCode, 'GR10286');
  assert.equal(pricing.breakdown.wastagePercent, 8);
  // The stone rate came from the rate table.
  assert.equal(pricingInput.diamonds[0].rate, 55000);
});

test("an employee's analyze prefetches in the employee's own scope", async () => {
  const scan = scanFor(EMPLOYEE, READING_WITH_CODES);
  lookups.length = 0;
  const { lookupsDuringRead } = await analyzeThroughController(EMPLOYEE, scan);
  // Own settings first (falling back to the shop's), own permissions.
  for (const name of [
    `goldRates:${BIZ}:${EMPLOYEE.userId}`,
    `labour:${EMPLOYEE.userId}`,
    `tax:${EMPLOYEE.userId}`,
    `diamondRates:${EMPLOYEE.userId}`,
    `colorstoneRates:${EMPLOYEE.userId}`,
    `wastageCodes:${EMPLOYEE.userId}`,
    `employee:${EMPLOYEE.userId}`,
  ]) {
    assert.ok(lookupsDuringRead.includes(name), `${name} ran during the read`);
  }
  assert.ok(!lookupsDuringRead.some((name) => name.includes(OWNER.userId)), "nothing in the owner's name");

  // The owner reads the shop's records and no roster entry.
  lookups.length = 0;
  const ownerRun = await analyzeThroughController(OWNER, scanFor(OWNER, READING_WITH_CODES));
  assert.ok(ownerRun.lookupsDuringRead.includes(`goldRates:${BIZ}:shop`));
  assert.ok(ownerRun.lookupsDuringRead.includes('labour:shop'));
  assert.ok(!ownerRun.lookupsDuringRead.some((name) => name.startsWith('employee:')));
});

test('a failed analysis leaves the prefetched reads to settle quietly', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const savedRates = rateCalculationService.getLiveGoldRates;
  rateCalculationService.getLiveGoldRates = async () => {
    throw new Error('rates down');
  };
  scanService.analyzeScan = async () => {
    await sleep(10);
    throw new Error('OCR_IMAGE_PROCESSING_FAILED');
  };
  try {
    let failure = null;
    await scanController.analyzeScan(
      { params: { scanId: 'scan-x' }, body: {}, user: OWNER, licenseContext: null },
      { status() { return this; }, json() { return this; } },
      (error) => {
        failure = error;
      },
    );
    assert.match(String(failure?.message), /OCR_IMAGE_PROCESSING_FAILED/);
    await sleep(30);
    assert.deepEqual(unhandled, []);
  } finally {
    rateCalculationService.getLiveGoldRates = savedRates;
    process.off('unhandledRejection', onUnhandled);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');

const calculationController = require('../src/controllers/calculation.controller');
const rateCalculationService = require('../src/services/rateCalculation.service');
const redisService = require('../src/services/redis.service');
const LabourRate = require('../src/models/labourRate.model');
const Employee = require('../src/models/employee.model');

const originalGetLiveGoldRates = rateCalculationService.getLiveGoldRates;
const originalGetScan = redisService.getScan;
const originalUpdateScanStatus = redisService.updateScanStatus;
const originalLabourFindOne = LabourRate.findOne;
const originalEmployeeFindById = Employee.findById;

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function approxEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) <= epsilon;
}

async function runController(reqOverrides = {}) {
  const req = {
    params: { scanId: 'scan-1' },
    user: { userId: 'u1', businessId: 'b1', role: 'OWNER' },
    body: {
      jewelleryType: 'DIAMOND',
      netWt: 10,
      grossWt: 12,
      purityKarat: '18K',
      diamonds: [
        { weight: 0.5, rate: 10000, discountPercent: 10 },
        { weight: 0.2, rate: 12000, discountPercent: 0 },
      ],
      colorstones: [
        { weight: 0.3, rate: 5000 },
        { weight: 0.2, rate: 2500 },
      ],
      otherCharges: 300,
      calculationMode: 'rtgs',
    },
    ...reqOverrides,
  };

  const res = mockRes();
  let nextErr = null;
  await calculationController.calculateMRP(req, res, (err) => {
    nextErr = err;
  });
  return { res, nextErr };
}

function setCommonMocks({ scanOwnerUserId = 'u1', scanBusinessId = 'b1', labourValue = 100 } = {}) {
  rateCalculationService.getLiveGoldRates = async () => ({
    karatRates: [{ carat: '18K', purity: 75 }],
    taxSettings: {
      rtgsFinalRate: 80000,
      cashFinalRate: 90000,
    },
    supremeChanges: { rtgsChange: 0, cashChange: 0 },
  });

  redisService.getScan = async () => ({
    scanId: 'scan-1',
    ownerUserId: scanOwnerUserId,
    businessId: scanBusinessId,
    status: 'READY_FOR_REVIEW',
    calculationMode: 'rtgs',
  });

  redisService.updateScanStatus = async (_scanId, status, extraData) => ({
    scanId: 'scan-1',
    status,
    ...extraData,
  });

  LabourRate.findOne = async () => ({
    chargeType: 'AMOUNT',
    value: labourValue,
    rupeesUnit: 'Per Gram',
  });

  Employee.findById = async () => ({ permissions: new Map() });
}

test.after(() => {
  rateCalculationService.getLiveGoldRates = originalGetLiveGoldRates;
  redisService.getScan = originalGetScan;
  redisService.updateScanStatus = originalUpdateScanStatus;
  LabourRate.findOne = originalLabourFindOne;
  Employee.findById = originalEmployeeFindById;
});

test('calculateMRP: RTGS total equals sum of components', async () => {
  setCommonMocks({ labourValue: 100 });

  const { res, nextErr } = await runController();
  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);

  const breakdown = res.body.data.breakdown;
  const expected =
    breakdown.goldAmount +
    breakdown.diamondAmount +
    breakdown.colorstoneAmount +
    breakdown.labourAmount +
    breakdown.otherCharges;

  assert.ok(approxEqual(breakdown.goldAmount, 60000));
  assert.ok(approxEqual(breakdown.diamondAmount, 6900));
  assert.ok(approxEqual(breakdown.colorstoneAmount, 2000));
  assert.ok(approxEqual(breakdown.labourAmount, 1000));
  assert.ok(approxEqual(breakdown.otherCharges, 300));
  assert.ok(approxEqual(res.body.data.finalMRP, expected));
});

test('calculateMRP: cash mode changes gold and final total correctly', async () => {
  setCommonMocks({ labourValue: 100 });

  const { res, nextErr } = await runController({
    body: {
      jewelleryType: 'DIAMOND',
      netWt: 10,
      grossWt: 12,
      purityKarat: '18K',
      diamonds: [{ weight: 0.5, rate: 10000, discountPercent: 10 }],
      colorstones: [{ weight: 0.3, rate: 5000 }],
      otherCharges: 300,
      calculationMode: 'cash',
    },
  });

  assert.equal(nextErr, null);
  const b = res.body.data.breakdown;
  const expected = b.goldAmount + b.diamondAmount + b.colorstoneAmount + b.labourAmount + b.otherCharges;

  // cash 90k/10 => 9k/g, with 75% purity => 6750/g, netWt=10 => 67500
  assert.ok(approxEqual(b.goldAmount, 67500));
  assert.ok(approxEqual(res.body.data.finalMRP, expected));
});

test('calculateMRP: labour gross-weight basis and per-10g unit are respected', async () => {
  setCommonMocks({ labourValue: 100 });

  const { res, nextErr } = await runController({
    body: {
      jewelleryType: 'GOLD',
      netWt: 10,
      grossWt: 12,
      purityKarat: '18K',
      diamonds: [],
      colorstones: [],
      labourChargeAmount: '200',
      labourChargeUnit: 'Per 10 Gram',
      labourWeightBasis: 'gross',
      otherCharges: 0,
      calculationMode: 'rtgs',
    },
  });

  assert.equal(nextErr, null);
  const b = res.body.data.breakdown;
  // gross 12g * (200/10) = 240
  assert.ok(approxEqual(b.labourAmount, 240));
  const expected = b.goldAmount + b.diamondAmount + b.colorstoneAmount + b.labourAmount + b.otherCharges;
  assert.ok(approxEqual(res.body.data.finalMRP, expected));
});

test('calculateMRP: rejects cross-user scan access', async () => {
  setCommonMocks({ scanOwnerUserId: 'user-a', scanBusinessId: 'b1' });

  const { res, nextErr } = await runController({
    user: { userId: 'user-b', businessId: 'b1', role: 'OWNER' },
  });

  assert.equal(res.body, null);
  assert.ok(nextErr);
  assert.equal(nextErr.statusCode, 403);
  assert.match(nextErr.message, /user mismatch/i);
});

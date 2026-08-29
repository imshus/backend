const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const scanBillingService = require('../src/services/scanBilling.service');
const licenseService = require('../src/services/license.service');
const billingConfigService = require('../src/services/billingConfig.service');
const paymentService = require('../src/services/payment.service');
const ScanBilling = require('../src/models/scanBilling.model');
const CreditTransaction = require('../src/models/creditTransaction.model');
const OrganizationWallet = require('../src/models/organizationWallet.model');

let replSet;
const originalGetLicenseOverview = licenseService.getLicenseOverview;
const originalGetEffectiveConfig = billingConfigService.getEffectiveConfig;
const originalCreditTransactionCreate = CreditTransaction.create.bind(CreditTransaction);
const originalStartSession = mongoose.startSession.bind(mongoose);

const businessId = () => new mongoose.Types.ObjectId();
const userId = () => new mongoose.Types.ObjectId();

function scanFixture(scanId, business, user) {
  return {
    scanId,
    businessId: business,
    ownerUserId: user,
    jewelleryType: 'DIAMOND',
    scanType: 'BOTH_SIDES',
  };
}

function analysisFixture() {
  return {
    provider: 'openai',
    billingMeta: {
      model: 'gpt-test',
      promptTokens: 0,
      completionTokens: 0,
    },
    structuredData: {},
  };
}

async function seedWallet(business, creditBalance = 10) {
  return OrganizationWallet.create({
    businessId: business,
    creditBalance,
    lifetimeScans: 0,
    monthScans: 0,
    todayScans: 0,
  });
}

test.before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  await Promise.all([
    ScanBilling.syncIndexes(),
    CreditTransaction.syncIndexes(),
    OrganizationWallet.syncIndexes(),
  ]);

  licenseService.getLicenseOverview = async () => ({
    scannerEnabled: true,
    license: {},
  });

  billingConfigService.getEffectiveConfig = async () => ({
    erf: 97,
    inputTokenPricePerMillionUsd: 0.2,
    outputTokenPricePerMillionUsd: 1.2,
    kComp: 0.27,
    aComp: 0,
    lowCreditThreshold: 20,
    criticalCreditThreshold: 10,
  });
});

test.beforeEach(async () => {
  CreditTransaction.create = originalCreditTransactionCreate;
  mongoose.startSession = originalStartSession;
  await Promise.all([
    ScanBilling.deleteMany({}),
    CreditTransaction.deleteMany({}),
    OrganizationWallet.deleteMany({}),
  ]);
});

test.after(async () => {
  licenseService.getLicenseOverview = originalGetLicenseOverview;
  billingConfigService.getEffectiveConfig = originalGetEffectiveConfig;
  CreditTransaction.create = originalCreditTransactionCreate;
  mongoose.startSession = originalStartSession;
  await mongoose.disconnect();
  await replSet.stop();
});

test('one successful completed scan creates one billing, deduction, and scan transaction', async () => {
  const business = businessId();
  const user = userId();
  await seedWallet(business, 10);

  const billing = await scanBillingService.billCompletedScan({
    scan: scanFixture('scan-success-1', business, user),
    analysisResult: analysisFixture(),
    session: { userId: user },
  });

  assert.equal(Number(billing.totalScanCharge), 0.27);
  assert.equal(await ScanBilling.countDocuments({ scanId: 'scan-success-1' }), 1);
  assert.equal(await CreditTransaction.countDocuments({ type: 'SCAN_DEDUCTION', 'metadata.scanId': 'scan-success-1' }), 1);

  const wallet = await OrganizationWallet.findOne({ businessId: business }).lean();
  assert.equal(wallet.creditBalance, 9.73);
  assert.equal(wallet.todayScans, 1);
  assert.equal(wallet.monthScans, 1);
});

test('same scanId billed twice remains idempotent with one deduction', async () => {
  const business = businessId();
  const user = userId();
  const scan = scanFixture('scan-idempotent-1', business, user);
  await seedWallet(business, 10);

  await scanBillingService.billCompletedScan({ scan, analysisResult: analysisFixture(), session: { userId: user } });
  await scanBillingService.billCompletedScan({ scan, analysisResult: analysisFixture(), session: { userId: user } });

  assert.equal(await ScanBilling.countDocuments({ scanId: scan.scanId }), 1);
  assert.equal(await CreditTransaction.countDocuments({ type: 'SCAN_DEDUCTION', 'metadata.scanId': scan.scanId }), 1);

  const wallet = await OrganizationWallet.findOne({ businessId: business }).lean();
  assert.equal(wallet.creditBalance, 9.73);
  assert.equal(wallet.todayScans, 1);
});

test('two simultaneous billing requests for same scanId commit one billing only', async () => {
  const business = businessId();
  const user = userId();
  const scan = scanFixture('scan-concurrent-1', business, user);
  await seedWallet(business, 10);

  const results = await Promise.allSettled([
    scanBillingService.billCompletedScan({ scan, analysisResult: analysisFixture(), session: { userId: user } }),
    scanBillingService.billCompletedScan({ scan, analysisResult: analysisFixture(), session: { userId: user } }),
  ]);

  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
  assert.equal(await ScanBilling.countDocuments({ scanId: scan.scanId }), 1);
  assert.equal(await CreditTransaction.countDocuments({ type: 'SCAN_DEDUCTION', 'metadata.scanId': scan.scanId }), 1);

  const wallet = await OrganizationWallet.findOne({ businessId: business }).lean();
  assert.equal(wallet.creditBalance, 9.73);
  assert.equal(wallet.todayScans, 1);
});

test('insufficient credits does not create billing or transaction', async () => {
  const business = businessId();
  const user = userId();
  const scan = scanFixture('scan-insufficient-1', business, user);
  await seedWallet(business, 0.1);

  await assert.rejects(
    () => scanBillingService.billCompletedScan({ scan, analysisResult: analysisFixture(), session: { userId: user } }),
    /INSUFFICIENT_CREDITS/,
  );

  assert.equal(await ScanBilling.countDocuments({ scanId: scan.scanId }), 0);
  assert.equal(await CreditTransaction.countDocuments({ type: 'SCAN_DEDUCTION', 'metadata.scanId': scan.scanId }), 0);

  const wallet = await OrganizationWallet.findOne({ businessId: business }).lean();
  assert.equal(wallet.creditBalance, 0.1);
  assert.equal(wallet.todayScans, 0);
});

test('credit transaction creation failure rolls back wallet deduction and billing', async () => {
  const business = businessId();
  const user = userId();
  const scan = scanFixture('scan-tx-failure-1', business, user);
  await seedWallet(business, 10);

  CreditTransaction.create = async (payload, options) => {
    const row = Array.isArray(payload) ? payload[0] : payload;
    if (row?.type === 'SCAN_DEDUCTION') {
      throw new Error('SIMULATED_CREDIT_TRANSACTION_FAILURE');
    }
    return originalCreditTransactionCreate(payload, options);
  };

  await assert.rejects(
    () => scanBillingService.billCompletedScan({ scan, analysisResult: analysisFixture(), session: { userId: user } }),
    /SIMULATED_CREDIT_TRANSACTION_FAILURE/,
  );

  assert.equal(await ScanBilling.countDocuments({ scanId: scan.scanId }), 0);
  assert.equal(await CreditTransaction.countDocuments({ type: 'SCAN_DEDUCTION', 'metadata.scanId': scan.scanId }), 0);

  const wallet = await OrganizationWallet.findOne({ businessId: business }).lean();
  assert.equal(wallet.creditBalance, 10);
  assert.equal(wallet.todayScans, 0);
});

test('overview summary is derived from persisted billing rows', async () => {
  const business = businessId();
  const user = userId();
  await seedWallet(business, 10);

  await scanBillingService.billCompletedScan({
    scan: scanFixture('scan-overview-1', business, user),
    analysisResult: analysisFixture(),
    session: { userId: user },
  });

  const summary = await paymentService.getMonthCostSummary({ businessId: business });
  assert.equal(summary.todayScans, 1);
  assert.equal(summary.monthScans, 1);
  assert.equal(summary.todayScanCost, 0.27);
  assert.equal(summary.currentMonthCost, 0.27);
});

test('standalone MongoDB transaction error falls back to idempotent billing flow', async () => {
  const business = businessId();
  const user = userId();
  const scan = scanFixture('scan-standalone-fallback-1', business, user);
  await seedWallet(business, 10);

  mongoose.startSession = async () => ({
    withTransaction: async () => {
      const error = new Error('Transaction numbers are only allowed on a replica set member or mongos');
      error.code = 20;
      throw error;
    },
    endSession: async () => {},
  });

  const billing = await scanBillingService.billCompletedScan({
    scan,
    analysisResult: analysisFixture(),
    session: { userId: user },
  });

  assert.equal(billing.billingStatus, 'SUCCEEDED');
  assert.equal(await ScanBilling.countDocuments({ scanId: scan.scanId, billingStatus: 'SUCCEEDED' }), 1);
  assert.equal(await CreditTransaction.countDocuments({ type: 'SCAN_DEDUCTION', 'metadata.scanId': scan.scanId }), 1);

  const wallet = await OrganizationWallet.findOne({ businessId: business }).lean();
  assert.equal(wallet.creditBalance, 9.73);
  assert.equal(wallet.todayScans, 1);
});

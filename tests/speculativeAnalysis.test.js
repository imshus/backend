/**
 * The speculative read (started when an image lands, before the app says what
 * its scanner settings are) is collected by /analyze whenever the model's
 * input would have been the same. Settings the prompt never reads must not
 * throw it away, and the labour setting is applied to it by rule.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.SPECULATIVE_SETTLE_MS = '1';

const redisService = require('../src/services/redis.service');
const openaiService = require('../src/services/openai.service');
const ocrPreprocessCache = require('../src/services/ocrPreprocess.cache');
const scanBillingService = require('../src/services/scanBilling.service');
const scanService = require('../src/services/scan.service');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpscan-speculate-'));
const session = { userId: 'user-1', businessId: 'business-1' };

const scans = new Map();
let modelCalls = [];
let labourRead = '12';

const original = {
  getScan: redisService.getScan,
  updateScanStatus: redisService.updateScanStatus,
  analyzeImages: openaiService.analyzeImages,
  warmPreprocess: ocrPreprocessCache.warmPreprocess,
  takePreprocessed: ocrPreprocessCache.takePreprocessed,
  billCompletedScan: scanBillingService.billCompletedScan,
};

test.before(() => {
  redisService.getScan = async (scanId) => scans.get(scanId) || null;
  redisService.updateScanStatus = async (scanId, status, extra = {}) => {
    const updated = { ...scans.get(scanId), ...extra, status };
    scans.set(scanId, updated);
    return updated;
  };
  openaiService.analyzeImages = async (front, back, type, scanType, scannerSettings) => {
    modelCalls.push({ scannerSettings });
    return {
      structuredData: {
        grossWeight: { value: '8.208', confidence: 97 },
        labour: { value: labourRead, confidence: 90 },
      },
      unknownFields: [],
    };
  };
  ocrPreprocessCache.warmPreprocess = () => {};
  ocrPreprocessCache.takePreprocessed = () => null;
  scanBillingService.billCompletedScan = async () => null;
});

test.after(() => {
  Object.assign(redisService, {
    getScan: original.getScan,
    updateScanStatus: original.updateScanStatus,
  });
  openaiService.analyzeImages = original.analyzeImages;
  ocrPreprocessCache.warmPreprocess = original.warmPreprocess;
  ocrPreprocessCache.takePreprocessed = original.takePreprocessed;
  scanBillingService.billCompletedScan = original.billCompletedScan;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let count = 0;
/** A scan with a front image uploaded under `speculate`, its read already done. */
const speculatedScan = async () => {
  count += 1;
  const scanId = `scan-${count}`;
  const file = path.join(tmpDir, `front-${count}.jpg`);
  fs.writeFileSync(file, 'jpeg');
  scans.set(scanId, {
    scanId,
    status: 'WAITING_FOR_SCAN',
    jewelleryType: 'DIAMOND',
    scanType: 'SINGLE_SIDE',
    ownerUserId: session.userId,
    businessId: session.businessId,
  });
  modelCalls = [];
  await scanService.saveImage(scanId, file, 'front', session, { speculate: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(modelCalls.length, 1, 'the speculative read started');
  return scanId;
};

test('settings the prompt never reads do not throw the speculative read away', async () => {
  labourRead = '12';
  const scanId = await speculatedScan();
  const updated = await scanService.analyzeScan(
    scanId,
    { defaultKarat: '18K', showRtgs: true },
    session.businessId,
    session,
  );
  assert.equal(modelCalls.length, 1, 'no second model call on the user\'s wait');
  assert.equal(updated.analysisResult.structuredData.grossWeight.value, '8.208');
});

test('the labour setting is applied to the speculative read by rule', async () => {
  labourRead = '12';
  const scanId = await speculatedScan();
  const updated = await scanService.analyzeScan(
    scanId,
    { labourChargePreference: 'PERCENTAGE' },
    session.businessId,
    session,
  );
  assert.equal(modelCalls.length, 1);
  assert.equal(updated.analysisResult.structuredData.labour.value, '12%');
});

test('a labour the rule cannot rewrite is read again with the setting in the prompt', async () => {
  labourRead = '12% + 300';
  const scanId = await speculatedScan();
  await scanService.analyzeScan(
    scanId,
    { labourChargePreference: 'AMOUNT' },
    session.businessId,
    session,
  );
  assert.equal(modelCalls.length, 2, 'a fresh read was made');
  assert.deepEqual(modelCalls[1].scannerSettings, { labourChargePreference: 'AMOUNT' });
});

test('a setting the prompt does read still asks for a fresh read', async () => {
  labourRead = '12';
  const scanId = await speculatedScan();
  // A different jewellery type is a different prompt.
  scans.set(scanId, { ...scans.get(scanId), jewelleryType: 'GOLD' });
  await scanService.analyzeScan(scanId, {}, session.businessId, session);
  assert.equal(modelCalls.length, 2);
});

test('applyLabourPreference rewrites plain figures only', () => {
  const reading = (value) => ({ structuredData: { labour: { value, confidence: 90 } } });
  const apply = (value, labourChargePreference) => {
    const data = reading(value);
    const ok = openaiService.applyLabourPreference(data, { labourChargePreference });
    return [ok, data.structuredData.labour.value];
  };
  assert.deepEqual(apply('12', 'PERCENTAGE'), [true, '12%']);
  assert.deepEqual(apply('12 %', 'PERCENTAGE'), [true, '12%']);
  assert.deepEqual(apply('12%', 'AMOUNT'), [true, '12']);
  assert.deepEqual(apply('1,250', 'AMOUNT'), [true, '1,250']);
  assert.deepEqual(apply('', 'PERCENTAGE'), [true, '']);
  assert.deepEqual(apply('850', undefined), [true, '850']);
  assert.deepEqual(apply('12% + 300', 'AMOUNT'), [false, '12% + 300']);
});

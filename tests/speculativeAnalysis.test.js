/**
 * The speculative read (started when an image lands, before the app says what
 * its scanner settings are) is collected by /analyze whenever the model's
 * input would have been the same. Settings the prompt never reads must not
 * throw it away, and the labour setting is applied to it by rule.
 *
 * It starts the moment the upload is recorded, with no settle delay; a retake
 * aborts the read in flight; and /analyze (the Calculate tap) joins a read that
 * is still running instead of starting its own.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A knob that used to hold the read back after an upload. It must not delay
// anything any more, however large it is set.
process.env.SPECULATIVE_SETTLE_MS = '60000';

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
// When set, each model call waits for release() (or its abort) before answering.
let holdReads = false;
const pending = new Set();
const releaseReads = () => {
  for (const release of pending) release();
  pending.clear();
};
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

const original = {
  getScan: redisService.getScan,
  updateScanStatus: redisService.updateScanStatus,
  analyzeImages: openaiService.analyzeImages,
  warmPreprocess: ocrPreprocessCache.warmPreprocess,
  beginWarm: ocrPreprocessCache.beginWarm,
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
  openaiService.analyzeImages = async (front, back, type, scanType, scannerSettings, scope, views, options = {}) => {
    const call = { front, scannerSettings, signal: options?.signal || null, answered: false };
    modelCalls.push(call);
    if (holdReads) {
      await new Promise((resolve, reject) => {
        pending.add(resolve);
        call.signal?.addEventListener('abort', () => {
          pending.delete(resolve);
          reject(abortError());
        });
      });
    }
    call.answered = true;
    return {
      structuredData: {
        grossWeight: { value: '8.208', confidence: 97 },
        labour: { value: labourRead, confidence: 90 },
      },
      unknownFields: [],
    };
  };
  ocrPreprocessCache.warmPreprocess = () => {};
  // saveImage starts the warm-up before the access check (beginWarm).
  ocrPreprocessCache.beginWarm = () => ({ commit() {}, discard() {} });
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
  ocrPreprocessCache.beginWarm = original.beginWarm;
  ocrPreprocessCache.takePreprocessed = original.takePreprocessed;
  scanBillingService.billCompletedScan = original.billCompletedScan;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let count = 0;
/** A new scan record and a photo on disk for it; the model call log is reset. */
const newScan = () => {
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
  return { scanId, file };
};
/** Lets the pipeline's own promise steps run; no timer is given a chance. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

/** A scan with a front image uploaded under `speculate`, its read already done. */
const speculatedScan = async () => {
  const { scanId, file } = newScan();
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

test('the read starts the moment the photo is recorded, with no settle delay', async () => {
  const { scanId, file } = newScan();
  await scanService.saveImage(scanId, file, 'front', session, { speculate: true });
  await turn();
  assert.equal(modelCalls.length, 1, 'the read is already at the model, before any Calculate tap');
  assert.deepEqual(modelCalls[0].scannerSettings, {}, 'it is the speculative read, not one made by /analyze');
  assert.equal(modelCalls[0].front, file);
  // Collected by the Calculate tap with no second call.
  await scanService.analyzeScan(scanId, {}, session.businessId, session);
  assert.equal(modelCalls.length, 1);
});

test('Calculate tapped while the read is still running joins it instead of reading again', async () => {
  holdReads = true;
  try {
    const { scanId, file } = newScan();
    await scanService.saveImage(scanId, file, 'front', session, { speculate: true });
    await turn();
    const analyzing = scanService.analyzeScan(
      scanId,
      { defaultKarat: '18K', showRtgs: true },
      session.businessId,
      session,
    );
    await turn();
    await turn();
    assert.equal(modelCalls.length, 1, 'no read of its own while the first one runs');
    assert.deepEqual(modelCalls[0].scannerSettings, {}, 'the running read is the speculative one');
    assert.equal(modelCalls[0].signal.aborted, false, 'and it was not cancelled');
    releaseReads();
    const updated = await analyzing;
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].answered, true);
    assert.equal(updated.status, 'ANALYSIS_COMPLETED');
    assert.equal(updated.analysisResult.structuredData.grossWeight.value, '8.208');
  } finally {
    holdReads = false;
    releaseReads();
  }
});

test('a retake aborts the read in flight and the new photo is read at once', async () => {
  holdReads = true;
  try {
    const { scanId, file } = newScan();
    await scanService.saveImage(scanId, file, 'front', session, { speculate: true });
    await turn();
    assert.equal(modelCalls.length, 1);
    const first = modelCalls[0];

    const retake = path.join(tmpDir, `front-${count}-retake.jpg`);
    fs.writeFileSync(retake, 'jpeg');
    await scanService.saveImage(scanId, retake, 'front', session, { speculate: true });
    await turn();
    assert.equal(first.signal.aborted, true, "the first photo's read was cancelled");
    assert.equal(first.answered, false);
    assert.equal(modelCalls.length, 2, 'the retake is read straight away');
    assert.equal(modelCalls[1].front, retake);

    const analyzing = scanService.analyzeScan(scanId, {}, session.businessId, session);
    await turn();
    await turn();
    assert.equal(modelCalls.length, 2, "Calculate joins the retake's read");
    releaseReads();
    const updated = await analyzing;
    assert.equal(modelCalls.length, 2);
    assert.equal(modelCalls[1].answered, true);
    assert.equal(updated.frontImagePath, retake);
    assert.equal(updated.status, 'ANALYSIS_COMPLETED');
  } finally {
    holdReads = false;
    releaseReads();
  }
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

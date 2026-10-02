/**
 * Every GST check during Create Account is kept in gst_verifications with
 * the name and mobile entered, passed or failed. A pass carries the details
 * GSTN returned (and the account goes on to be created); a failure creates no
 * account but is still stored, with its reason and the attempt and failure
 * counts. The reply itself is never changed, and a throttled caller is not
 * logged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'gstVerificationLog.service.js');
const calls = { upserts: [], updateMany: [] };

const resolvedFrom = (from, request) => Module._resolveFilename(request, {
  id: from,
  filename: from,
  paths: Module._nodeModulePaths(path.dirname(from)),
});
const modelPath = resolvedFrom(SERVICE, '../models/gstVerification.model');
require.cache[modelPath] = {
  id: modelPath,
  filename: modelPath,
  loaded: true,
  exports: {
    findOneAndUpdate: async (filter, update, options) => {
      calls.upserts.push({ filter, update, options });
      return { ...filter };
    },
    updateMany: async (filter, update) => {
      calls.updateMany.push({ filter, update });
      return { modifiedCount: 1 };
    },
  },
};

const { logGstCheck } = require('../src/middleware/gstVerificationLog.middleware');

const reset = () => { calls.upserts = []; calls.updateMany = []; };
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Runs the logger for a step, then answers the way the handler would. */
const run = async (step, body, status, reply) => {
  const res = {
    statusCode: 200,
    sent: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.sent = payload; return this; },
  };
  let nextCalled = false;
  logGstCheck(step)({ body }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  res.status(status).json(reply);
  await flush();
  return res;
};

const VERIFIED_REPLY = {
  success: true,
  data: {
    gstNumber: '27AABCG1234F1Z5',
    legalName: 'Gupta Jewellers Pvt. Ltd.',
    tradeName: 'Gupta Jewellers',
    businessType: 'Private Limited Company',
    companyType: 'Private Limited Company',
    address: '12, Zaveri Bazaar, Mumbai',
    stateCode: '27',
    stateName: 'Maharashtra',
    pincode: '400002',
    gstStatus: 'Active',
  },
};

test('a pass is stored with the GSTN details, the name and the mobile', async () => {
  reset();
  const res = await run('verify', { gstNumber: '27aabcg1234f1z5', fullName: '  Ravi   Gupta ', mobile: '+91 98765-43210' }, 200, VERIFIED_REPLY);
  assert.deepEqual(res.sent, VERIFIED_REPLY);
  assert.equal(calls.upserts.length, 1);
  const [{ filter, update, options }] = calls.upserts;
  assert.deepEqual(filter, { mobile: '9876543210', gstNumber: '27AABCG1234F1Z5' });
  assert.equal(update.$set.status, 'VERIFIED');
  assert.equal(update.$set.fullName, 'Ravi Gupta');
  assert.equal(update.$set.details.legalName, 'Gupta Jewellers Pvt. Ltd.');
  assert.equal(update.$set.details.tradeName, 'Gupta Jewellers');
  assert.equal(update.$set.details.pincode, '400002');
  assert.equal(update.$set.details.gstStatus, 'Active');
  assert.deepEqual(update.$inc, { attempts: 1 });
  assert.equal(options.upsert, true);
  // This mobile's earlier failed numbers are marked resolved.
  assert.equal(calls.updateMany.length, 1);
  assert.deepEqual(calls.updateMany[0].filter, {
    mobile: '9876543210',
    gstNumber: { $ne: '27AABCG1234F1Z5' },
    status: 'FAILED',
    resolvedAt: null,
  });
});

test('a failure creates no account but is stored with the reason and counted', async () => {
  reset();
  const reply = { success: false, error: 'INVALID_GST_NUMBER', message: 'The provided GST number is invalid.' };
  const res = await run('verify', { gstNumber: '27AABCG1234F1Z5', fullName: 'Ravi', mobile: '9876543210' }, 400, reply);
  assert.deepEqual(res.sent, reply);
  const [{ update }] = calls.upserts;
  assert.equal(update.$set.status, 'FAILED');
  assert.equal(update.$set.reason, 'The provided GST number is invalid.');
  assert.equal(update.$set.errorCode, 'INVALID_GST_NUMBER');
  assert.equal(update.$set.statusCode, 400);
  assert.deepEqual(update.$inc, { attempts: 1, failures: 1 });
  assert.equal(calls.updateMany.length, 0);
});

test('a malformed number refused by validation, and the lookup failing, are stored too', async () => {
  reset();
  await run('verify', { gstNumber: '27ABC', fullName: 'Ravi', mobile: '9876543210' }, 400, { success: false, error: 'INVALID_GST_NUMBER' });
  assert.equal(calls.upserts[0].update.$set.reason, 'INVALID_GST_NUMBER');
  reset();
  await run('verify', { gstNumber: '27AABCG1234F1Z5', mobile: '9876543210' }, 502, { success: false, error: 'GST_VERIFICATION_FAILED', message: 'GST verification is unavailable.' });
  assert.equal(calls.upserts[0].update.$set.statusCode, 502);
  // No name sent (an older app): the stored name is left as it was.
  assert.equal('fullName' in calls.upserts[0].update.$set, false);
});

test('the confirm step records the account created with the number', async () => {
  reset();
  await run('confirm', { gstNumber: '27AABCG1234F1Z5', fullName: 'Ravi', mobile: '9876543210' }, 200, { success: true, data: { businessId: 'biz-77' } });
  const [{ filter, update }] = calls.upserts;
  assert.deepEqual(filter, { mobile: '9876543210', gstNumber: '27AABCG1234F1Z5' });
  assert.equal(update.$set.status, 'VERIFIED');
  assert.equal(update.$set.businessId, 'biz-77');
  assert.ok(update.$set.confirmedAt instanceof Date);
});

test('a throttled caller is not logged', async () => {
  reset();
  await run('verify', { gstNumber: '27AABCG1234F1Z5', mobile: '9876543210' }, 429, { success: false });
  assert.equal(calls.upserts.length, 0);
});

test('a pass with no mobile is stored but resolves nothing else', async () => {
  reset();
  await run('verify', { gstNumber: '27AABCG1234F1Z5' }, 200, VERIFIED_REPLY);
  assert.equal(calls.upserts.length, 1);
  assert.equal(calls.upserts[0].filter.mobile, '');
  assert.equal(calls.updateMany.length, 0);
});

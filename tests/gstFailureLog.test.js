/**
 * A GST number that cannot be verified at sign-up is stored with the name
 * and mobile entered (gst_verification_failures): every refusal the check
 * answers with is logged, the reply itself is untouched, a throttled caller
 * is not logged, and a later pass from the same mobile resolves the rows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'gstFailureLog.service.js');
const calls = { upserts: [], resolves: [] };

const stubFor = (from, request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: from,
    filename: from,
    paths: Module._nodeModulePaths(path.dirname(from)),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stubFor(SERVICE, '../models/gstVerificationFailure.model', {
  findOneAndUpdate: async (filter, update, options) => {
    calls.upserts.push({ filter, update, options });
    return { ...filter };
  },
  updateMany: async (filter, update) => {
    calls.resolves.push({ filter, update });
    return { modifiedCount: 1 };
  },
});

const { logGstVerifyOutcome } = require('../src/middleware/gstFailureLog.middleware');

const reset = () => { calls.upserts = []; calls.resolves = []; };
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Runs the middleware, then answers the way a handler would. */
const run = async (body, status, reply) => {
  const res = {
    statusCode: 200,
    sent: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.sent = payload; return this; },
  };
  let nextCalled = false;
  logGstVerifyOutcome({ body }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  res.status(status).json(reply);
  await flush();
  return res;
};

test('a GST number GSTN refuses is stored with the name and mobile, reply untouched', async () => {
  reset();
  const reply = { success: false, error: 'INVALID_GST_NUMBER', message: 'The provided GST number is invalid.' };
  const res = await run(
    { gstNumber: '27aabcg1234f1z5', fullName: '  Ravi   Gupta ', mobile: '+91 98765-43210' },
    400,
    reply,
  );
  assert.deepEqual(res.sent, reply);
  assert.equal(calls.upserts.length, 1);
  const [{ filter, update, options }] = calls.upserts;
  assert.deepEqual(filter, { mobile: '9876543210', gstNumber: '27AABCG1234F1Z5' });
  assert.equal(update.$set.fullName, 'Ravi Gupta');
  assert.equal(update.$set.reason, 'The provided GST number is invalid.');
  assert.equal(update.$set.errorCode, 'INVALID_GST_NUMBER');
  assert.equal(update.$set.statusCode, 400);
  assert.deepEqual(update.$inc, { attempts: 1 });
  assert.equal(options.upsert, true);
});

test('a malformed number refused by validation is stored too', async () => {
  reset();
  await run({ gstNumber: '27ABC', fullName: 'Ravi', mobile: '9876543210' }, 400, { success: false, error: 'INVALID_GST_NUMBER' });
  assert.equal(calls.upserts.length, 1);
  assert.equal(calls.upserts[0].update.$set.reason, 'INVALID_GST_NUMBER');
  assert.equal(calls.upserts[0].update.$set.errorCode, '');
});

test('the lookup itself failing (5xx) is stored as unable to verify', async () => {
  reset();
  await run({ gstNumber: '27AABCG1234F1Z5', mobile: '9876543210' }, 502, { success: false, error: 'GST_VERIFICATION_FAILED', message: 'GST verification is unavailable.' });
  assert.equal(calls.upserts[0].update.$set.statusCode, 502);
  // No name sent (an older app): the stored name is left as it was.
  assert.equal('fullName' in calls.upserts[0].update.$set, false);
});

test('a throttled caller is not logged', async () => {
  reset();
  await run({ gstNumber: '27AABCG1234F1Z5', mobile: '9876543210' }, 429, { success: false });
  assert.equal(calls.upserts.length, 0);
  assert.equal(calls.resolves.length, 0);
});

test('a pass from the same mobile resolves its open failures', async () => {
  reset();
  await run({ gstNumber: '27AABCG1234F1Z5', mobile: '98765 43210' }, 200, { success: true, data: {} });
  assert.equal(calls.upserts.length, 0);
  assert.equal(calls.resolves.length, 1);
  assert.deepEqual(calls.resolves[0].filter, { mobile: '9876543210', resolvedAt: null });
  assert.equal(calls.resolves[0].update.$set.resolvedGstNumber, '27AABCG1234F1Z5');
});

test('a pass with no mobile resolves nothing', async () => {
  reset();
  await run({ gstNumber: '27AABCG1234F1Z5' }, 200, { success: true });
  assert.equal(calls.resolves.length, 0);
});

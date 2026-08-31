/**
 * "Forgot User ID": a phone number plus a valid OTP returns that account's
 * User ID from the database — and nothing else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'registration.service.js');
const SERVICE_DIR = path.dirname(SERVICE);

const state = { user: null, otpCalls: [], otpThrows: false, query: null };

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: SERVICE, filename: SERVICE, paths: Module._nodeModulePaths(SERVICE_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('../models/businessUser.model', {
  findOne: async (query) => { state.query = query; return state.user; },
});
stub('../models/business.model', { findById: async () => null, findOne: async () => null });
stub('../redis/redisClient', { get: async () => null, set: async () => {} });
stub('./otp.service', {
  verifyOtpByMobile: async (args) => {
    state.otpCalls.push(args);
    if (state.otpThrows) throw new Error('INVALID_OTP');
  },
});
stub('../repositories/otp.repository', {});
stub('./auth.service', { generateTokens: () => ({ accessToken: 'a', refreshToken: 'r' }) });
stub('./license.service', {});
stub('./wallet.service', {});

const { recoverUserId } = require(SERVICE);

const reset = () => {
  state.user = null;
  state.otpCalls = [];
  state.otpThrows = false;
  state.query = null;
};

test('returns the User ID stored against that phone number', async () => {
  reset();
  state.user = { phone: '9876543210', userId: 'garg.jewellers', isActive: true };

  const result = await recoverUserId('+91 98765 43210', '123456');

  assert.deepEqual(result, { userId: 'garg.jewellers' });
  assert.deepEqual(state.query, { phone: '9876543210' }, 'looks up by normalized phone');
});

test('issues no session — only the User ID comes back', async () => {
  reset();
  state.user = { phone: '9876543210', userId: 'garg.jewellers', isActive: true };

  const result = await recoverUserId('9876543210', '123456');

  assert.deepEqual(Object.keys(result), ['userId']);
  for (const leaked of ['accessToken', 'refreshToken', 'businessId', 'role']) {
    assert.equal(result[leaked], undefined, `${leaked} must not be returned`);
  }
});

test('the OTP is verified before any lookup happens', async () => {
  reset();
  state.otpThrows = true;
  state.user = { phone: '9876543210', userId: 'garg.jewellers', isActive: true };

  await assert.rejects(() => recoverUserId('9876543210', '000000'), /INVALID_OTP/);
  assert.equal(state.query, null, 'must not read the account without a valid OTP');
});

test('an unknown phone number is rejected', async () => {
  reset();
  state.user = null;
  await assert.rejects(() => recoverUserId('9999999999', '123456'), /INVALID_PHONE_CREDENTIALS/);
});

test('a deactivated account is rejected', async () => {
  reset();
  state.user = { phone: '9876543210', userId: 'garg.jewellers', isActive: false };
  await assert.rejects(() => recoverUserId('9876543210', '123456'), /INVALID_PHONE_CREDENTIALS/);
});

test('an account with no User ID reports that, rather than echoing the phone', async () => {
  reset();
  state.user = { phone: '9876543210', userId: '', isActive: true };
  await assert.rejects(() => recoverUserId('9876543210', '123456'), /NO_USER_ID_SET/);
});

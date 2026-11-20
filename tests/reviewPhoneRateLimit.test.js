// The App Store review number is never locked out by the OTP limits; every
// other number still is.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.USE_MEMORY_STORE = 'true';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.MSG91_AUTH_KEY = 'test';
process.env.MSG91_TEMPLATE_ID = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.SANDBOX_API_KEY = 'test';
process.env.SANDBOX_API_SECRET = 'test';
process.env.MPIN_VAULT_KEY = 'test-vault-key';
process.env.REVIEW_LOGIN_PHONE = '9999999999';
process.env.REVIEW_LOGIN_OTP = '123456';

const { otpSendLimiter, otpVerifyLimiter } = require('../src/middleware/rateLimiter');

// Runs the limiter the way Express would and reports what it did.
const hit = (limiter, mobile) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json() { resolve(this.statusCode); },
  };
  limiter({ body: { mobile } }, res, (error) => (error ? reject(error) : resolve(200)));
});

test('the review number passes the OTP check limit however often it tries', async () => {
  for (let i = 0; i < 40; i += 1) {
    assert.equal(await hit(otpVerifyLimiter, '9999999999'), 200);
  }
});

test('the review number passes the OTP send limit however often it asks', async () => {
  for (let i = 0; i < 25; i += 1) {
    assert.equal(await hit(otpSendLimiter, '9999999999'), 200);
  }
});

test('any other number is still stopped after 15 checks an hour', async () => {
  const codes = [];
  for (let i = 0; i < 16; i += 1) codes.push(await hit(otpVerifyLimiter, '9876500011'));
  assert.deepEqual(codes.slice(0, 15), Array(15).fill(200));
  assert.equal(codes[15], 429);
});

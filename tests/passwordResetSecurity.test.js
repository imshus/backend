const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// Keep this test independent from developer or production credentials.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.GEMINI_API_KEY = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.MSG91_AUTH_KEY = 'test';
process.env.MSG91_TEMPLATE_ID = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.SANDBOX_API_KEY = 'test';
process.env.SANDBOX_API_SECRET = 'test';

const authService = require('../src/services/auth.service');
const otpRepository = require('../src/repositories/otp.repository');
const otpService = require('../src/services/otp.service');

test('password reset token is purpose-bound and retains its one-time nonce', () => {
  const token = authService.generatePasswordResetToken('business-1', 'user-1', 'nonce-1');
  const payload = authService.verifyPasswordResetToken(token);

  assert.equal(payload.purpose, 'PASSWORD_RESET');
  assert.equal(payload.businessId, 'business-1');
  assert.equal(payload.userId, 'user-1');
  assert.equal(payload.nonce, 'nonce-1');
});

test('ordinary login access tokens cannot be used as password reset tokens', () => {
  const { accessToken } = authService.generateTokens('business-1', 'user-1', 'OWNER');
  assert.throws(
    () => authService.verifyPasswordResetToken(accessToken),
    /INVALID_RESET_TOKEN/,
  );
});

test('expired password reset tokens are rejected explicitly', () => {
  const expiredToken = jwt.sign(
    {
      businessId: 'business-1',
      userId: 'user-1',
      nonce: 'nonce-1',
      purpose: 'PASSWORD_RESET',
    },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: -1 },
  );

  assert.throws(
    () => authService.verifyPasswordResetToken(expiredToken),
    /RESET_TOKEN_EXPIRED/,
  );
});

test('password reset OTP verification is isolated to PASSWORD_RESET records', async (t) => {
  let saved = false;
  const record = {
    otp: '123456',
    verified: false,
    status: 'SENT',
    requestId: 'request-1',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    save: async () => {
      saved = true;
    },
  };

  t.mock.method(otpRepository, 'findLatestByMobileAndFlow', async (mobile, flow) => {
    assert.equal(mobile, '9876543210');
    assert.equal(flow, 'PASSWORD_RESET');
    return record;
  });

  const result = await otpService.verifyOtpByMobile({
    mobile: '9876543210',
    otp: '123456',
    flow: 'PASSWORD_RESET',
    rejectAlreadyVerified: true,
  });

  assert.equal(result.verified, true);
  assert.equal(record.verified, true);
  assert.equal(record.status, 'VERIFIED');
  assert.equal(saved, true);
});

test('used password reset OTPs cannot mint another reset token', async (t) => {
  t.mock.method(otpRepository, 'findLatestByMobileAndFlow', async () => ({
    otp: '123456',
    verified: true,
    status: 'VERIFIED',
    requestId: 'request-1',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  }));

  await assert.rejects(
    otpService.verifyOtpByMobile({
      mobile: '9876543210',
      otp: '123456',
      flow: 'PASSWORD_RESET',
      rejectAlreadyVerified: true,
    }),
    /OTP_ALREADY_USED/,
  );
});

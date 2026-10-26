const test = require('node:test');
const assert = require('node:assert/strict');

const axios = require('axios');
const otpService = require('../src/services/otp.service');
const otpRepository = require('../src/repositories/otp.repository');

const originalAxiosPost = axios.post;
const originalCreateOtpRecord = otpRepository.createOtpRecord;
const originalUpdateOtpRecord = otpRepository.updateOtpRecord;
const originalFindLatestByMobile = otpRepository.findLatestByMobile;
const originalFindLatestByBusinessTypeAndFlow = otpRepository.findLatestByBusinessTypeAndFlow;

test.after(() => {
  axios.post = originalAxiosPost;
  otpRepository.createOtpRecord = originalCreateOtpRecord;
  otpRepository.updateOtpRecord = originalUpdateOtpRecord;
  otpRepository.findLatestByMobile = originalFindLatestByMobile;
  otpRepository.findLatestByBusinessTypeAndFlow = originalFindLatestByBusinessTypeAndFlow;
});

test('sendMobileOtp stores and sends OTP through MSG91', async () => {
  let createdPayload;
  let updatedPayload;

  otpRepository.createOtpRecord = async (payload) => {
    createdPayload = payload;
    return { _id: 'otp-1', ...payload };
  };

  otpRepository.updateOtpRecord = async (_id, payload) => {
    updatedPayload = payload;
    return { _id, ...payload };
  };

  otpRepository.findLatestByMobile = async () => null;

  axios.post = async () => ({
    status: 200,
    data: {
      type: 'success',
      message: 'OTP sent successfully',
      request_id: 'msg91-req-1',
    },
  });

  const result = await otpService.sendMobileOtp({
    mobile: '9876543210',
    flow: 'LOGIN',
    route: '/api/v1/auth/send-otp',
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 'SENT');
  assert.equal(result.requestId, 'msg91-req-1');
  assert.equal(createdPayload.mobile, '9876543210');
  assert.equal(createdPayload.otpType, 'MOBILE');
  assert.equal(createdPayload.status, 'GENERATED');
  assert.equal(updatedPayload.status, 'SENT');
});

test('verifyOtpByMobile marks latest OTP verified without expiry checks', async () => {
  const record = {
    otp: '123456',
    verified: false,
    status: 'SENT',
    requestId: 'msg91-req-2',
    save: async function save() {
      this.verified = true;
      this.status = 'VERIFIED';
    },
  };

  otpRepository.findLatestByMobile = async () => record;

  const result = await otpService.verifyOtpByMobile({
    mobile: '9876543210',
    otp: '123456',
    route: '/api/v1/auth/verify-otp',
  });

  assert.equal(result.verified, true);
  assert.equal(result.alreadyVerified, false);
  assert.equal(record.verified, true);
  assert.equal(record.status, 'VERIFIED');
});

test('verifyOtpByMobile rejects invalid OTP', async () => {
  otpRepository.findLatestByMobile = async () => ({
    otp: '999999',
    verified: false,
    status: 'SENT',
    requestId: 'msg91-req-3',
    save: async () => {},
  });

  await assert.rejects(
    () => otpService.verifyOtpByMobile({ mobile: '9876543210', otp: '123456' }),
    { message: 'OTP_INVALID' }
  );
});

test('sendMobileOtp returns explicit auth error when MSG91 rejects auth key/token', async () => {
  otpRepository.createOtpRecord = async (payload) => ({ _id: 'otp-auth-1', ...payload });
  otpRepository.updateOtpRecord = async () => ({});
  otpRepository.findLatestByMobile = async () => null;

  axios.post = async () => ({
    status: 200,
    data: {
      type: 'error',
      request_id: 'Invalid authkey or Token',
    },
  });

  await assert.rejects(
    () => otpService.sendMobileOtp({ mobile: '9625060017', flow: 'SIGNUP' }),
    { message: 'MSG91_AUTH_ERROR' }
  );
});

test('the sign-up phone check reads only the code sign-up sent, and not past its ten minutes', async () => {
  let asked;
  const record = {
    otp: '123456',
    verified: false,
    status: 'SENT',
    expiresAt: new Date(Date.now() + 60_000),
    save: async () => {},
  };
  otpRepository.findLatestByBusinessTypeAndFlow = async (...args) => {
    asked = args;
    return record;
  };

  assert.equal(await otpService.verifyOtp('business-1', 'PHONE', '123456'), true);
  assert.deepEqual(asked, ['business-1', 'PHONE', 'SIGNUP'], 'a shop\'s employee-phone codes are never read');

  record.expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(
    () => otpService.verifyOtp('business-1', 'PHONE', '123456'),
    { message: 'OTP_EXPIRED' },
  );
});

test('the App Store review number gets its fixed code and no SMS; every other number is unchanged', async () => {
  const config = require('../src/config/env');
  const original = config.reviewLogin;
  config.reviewLogin = { phone: '9999999999', otp: '123456' };
  try {
    const created = [];
    const updated = [];
    let smsSent = 0;
    otpRepository.createOtpRecord = async (payload) => {
      created.push(payload);
      return { _id: `otp-review-${created.length}`, ...payload };
    };
    otpRepository.updateOtpRecord = async (_id, payload) => {
      updated.push(payload);
      return {};
    };
    axios.post = async () => {
      smsSent += 1;
      return { status: 200, data: { type: 'success', request_id: 'msg91-req-review' } };
    };

    for (const flow of ['LOGIN', 'SIGNUP', 'ACCOUNT_DELETE']) {
      const result = await otpService.sendMobileOtp({ mobile: '+91 99999 99999', flow });
      assert.equal(result.status, 'SENT');
    }
    assert.equal(smsSent, 0, 'no SMS for the review number');
    assert.deepEqual(created.map((row) => row.otp), ['123456', '123456', '123456']);
    assert.ok(created.every((row) => row.mobile === '9999999999' && row.expiresAt > new Date()));
    assert.ok(updated.every((row) => row.status === 'SENT'));

    // No shop may take the review number as its employee's with that code.
    await assert.rejects(
      () => otpService.sendMobileOtp({ mobile: '9999999999', flow: 'EMPLOYEE_PHONE', businessId: 'shop-1' }),
      { message: 'REVIEW_PHONE_RESERVED' },
    );
    assert.equal(created.length, 3, 'nothing stored for a refused send');

    // Any other number still gets a random code by SMS.
    await otpService.sendMobileOtp({ mobile: '9876543210', flow: 'LOGIN' });
    assert.equal(smsSent, 1);
    assert.match(created[3].otp, /^[0-9]{6}$/);
    assert.equal(created[3].mobile, '9876543210');
  } finally {
    config.reviewLogin = original;
  }
});

test('the review code still has to be typed right, and verifies like any other', async () => {
  const record = {
    otp: '123456',
    verified: false,
    status: 'SENT',
    expiresAt: new Date(Date.now() + 60_000),
    save: async () => {},
  };
  otpRepository.findLatestByMobile = async () => record;

  await assert.rejects(
    () => otpService.verifyOtpByMobile({ mobile: '9999999999', otp: '654321' }),
    { message: 'OTP_INVALID' },
  );
  const result = await otpService.verifyOtpByMobile({ mobile: '9999999999', otp: '123456' });
  assert.equal(result.verified, true);
});

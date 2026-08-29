const test = require('node:test');
const assert = require('node:assert/strict');

const axios = require('axios');
const otpService = require('../src/services/otp.service');
const otpRepository = require('../src/repositories/otp.repository');

const originalAxiosPost = axios.post;
const originalCreateOtpRecord = otpRepository.createOtpRecord;
const originalUpdateOtpRecord = otpRepository.updateOtpRecord;
const originalFindLatestByMobile = otpRepository.findLatestByMobile;
const originalFindLatestByBusinessAndType = otpRepository.findLatestByBusinessAndType;

test.after(() => {
  axios.post = originalAxiosPost;
  otpRepository.createOtpRecord = originalCreateOtpRecord;
  otpRepository.updateOtpRecord = originalUpdateOtpRecord;
  otpRepository.findLatestByMobile = originalFindLatestByMobile;
  otpRepository.findLatestByBusinessAndType = originalFindLatestByBusinessAndType;
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

const axios = require('axios');
const { randomUUID } = require('crypto');
const config = require('../config/env');
const otpRepository = require('../repositories/otp.repository');
const {
  divider,
  summary,
  logContext,
  logErrorSection,
} = require('../utils/otp.logger');

const devOtpStore = new Map();

const MSG91_OTP_URL = 'https://control.msg91.com/api/v5/otp';
const MSG91_MAX_ATTEMPTS = 4;
const MSG91_RETRY_BASE_DELAY_MS = 700;

function nowIso() {
  return new Date().toISOString();
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeMobile(mobile) {
  const digits = String(mobile || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  return digits;
}

function ensureMobile(mobile) {
  const normalized = normalizeMobile(mobile);
  if (!/^\d{10}$/.test(normalized)) {
    throw new Error('INVALID_MOBILE_NUMBER');
  }
  return normalized;
}

function rememberDevOtp(key, type, otp, destination) {
  const entry = devOtpStore.get(key) || {};
  entry[type.toLowerCase()] = otp;
  devOtpStore.set(key, entry);
}

function getDevOtps(key) {
  return devOtpStore.get(key) || {};
}

function parseMsg91Result(responseData) {
  const type = String(responseData?.type || '').toLowerCase();
  const isSuccess = type === 'success' || (!type && !!(responseData?.request_id || responseData?.requestId));
  const fallbackMessage = (type === 'error' && typeof responseData?.request_id === 'string')
    ? responseData.request_id
    : null;
  return {
    isSuccess,
    requestId: responseData?.request_id || responseData?.requestId || null,
    message: responseData?.message || fallbackMessage,
    errorCode: responseData?.code || responseData?.error || null,
  };
}

function isMsg91AuthError(parsed) {
  const text = String(parsed?.message || parsed?.requestId || '').toLowerCase();
  return text.includes('invalid authkey')
    || text.includes('invalid auth key')
    || text.includes('invalid token');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMsg91Otp({ mobile, otp, requestId, route }) {
  const authKey = String(config.msg91?.authKey || '').trim();
  const templateId = String(config.msg91?.templateId || '').trim();
  const authFingerprint = authKey
    ? `${authKey.slice(0, 4)}...${authKey.slice(-4)} (len=${authKey.length})`
    : 'NA';

  divider('MSG91 REQUEST');
  console.log(`Auth Key Loaded: ${authKey ? 'YES' : 'NO'}`);
  console.log(`Auth Key Fingerprint: ${authFingerprint}`);
  console.log(`Template Loaded: ${templateId ? 'YES' : 'NO'}`);

  if (!authKey || !templateId) {
    throw new Error('MSG91_CONFIG_MISSING');
  }

  const payload = { otp };
  console.log(`Payload Generated: ${JSON.stringify({ mobile: `91${mobile}`, templateId })}`);
  console.log('Sending Request...');

  try {
    for (let attempt = 1; attempt <= MSG91_MAX_ATTEMPTS; attempt += 1) {
      const response = await axios.post(MSG91_OTP_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          authkey: authKey,
        },
        params: {
          template_id: templateId,
          mobile: `91${mobile}`,
          authkey: authKey,
          otp,
          otp_expiry: 10,
          realTimeResponse: 1,
        },
        timeout: 12000,
      });

      const parsed = parseMsg91Result(response.data);

      divider('MSG91 RESPONSE');
      console.log(`Attempt: ${attempt}/${MSG91_MAX_ATTEMPTS}`);
      console.log(`HTTP Status: ${response.status}`);
      console.log(`API Response: ${JSON.stringify(response.data)}`);
      console.log(`Request ID: ${parsed.requestId || requestId}`);
      console.log(`Message: ${parsed.message || 'NA'}`);
      console.log(`Error Code: ${parsed.errorCode || 'NA'}`);

      divider('DLT CHECK');
      console.log(`Template Used: YES`);
      console.log(`Template ID: ${templateId}`);
      console.log(`DLT Validation Passed: ${parsed.isSuccess ? 'YES' : 'NO'}`);

      if (parsed.isSuccess) {
        return {
          status: 'SENT',
          requestId: parsed.requestId || requestId,
          msg91Response: response.data,
          route,
        };
      }

      const authError = isMsg91AuthError(parsed);
      const shouldRetry = authError && attempt < MSG91_MAX_ATTEMPTS;

      if (!shouldRetry) {
        const err = new Error(authError ? 'MSG91_AUTH_ERROR' : 'MSG91_SEND_FAILED');
        err.statusCode = 502;
        err.msg91Response = response.data;
        throw err;
      }

      const delayMs = MSG91_RETRY_BASE_DELAY_MS * attempt;
      console.warn(`[MSG91] Auth error on attempt ${attempt}. Retrying in ${delayMs}ms...`);
      await wait(delayMs);
    }

    const err = new Error('MSG91_SEND_FAILED');
    err.statusCode = 502;
    throw err;
  } catch (error) {
    const httpStatus = error.response?.status;
    const msg91Response = error.response?.data || error.msg91Response || null;

    if (
      error.message === 'MSG91_CONFIG_MISSING'
      || error.message === 'MSG91_SEND_FAILED'
      || error.message === 'MSG91_AUTH_ERROR'
      || error.message === 'MSG91_CLIENT_ERROR'
      || error.message === 'MSG91_SERVER_ERROR'
      || error.message === 'MSG91_TIMEOUT'
      || error.message === 'MSG91_NETWORK_ERROR'
    ) {
      throw error;
    }

    divider('DLT CHECK');
    console.log('Template Used: YES');
    console.log(`Template ID: ${templateId || 'NA'}`);
    console.log('DLT Validation Failed: YES');
    console.log(`Failure Reason: ${error.message}`);

    logErrorSection('MSG91 ERROR', {
      timestamp: nowIso(),
      route,
      requestId,
      mobile,
      message: error.message,
      stack: error.stack,
      msg91Response,
    });

    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      const err = new Error('MSG91_CLIENT_ERROR');
      err.statusCode = 502;
      err.msg91Response = msg91Response;
      throw err;
    }

    if (httpStatus && httpStatus >= 500) {
      const err = new Error('MSG91_SERVER_ERROR');
      err.statusCode = 502;
      err.msg91Response = msg91Response;
      throw err;
    }

    if (error.code === 'ECONNABORTED') {
      const err = new Error('MSG91_TIMEOUT');
      err.statusCode = 504;
      err.msg91Response = msg91Response;
      throw err;
    }

    const err = new Error('MSG91_NETWORK_ERROR');
    err.statusCode = 502;
    err.msg91Response = msg91Response;
    throw err;
  }
}

async function createOtpRecord({ businessId, otpType, destination, mobile, otp, flow, requestId, status, msg91Response }) {
  divider('OTP DATABASE');
  const payload = {
    businessId,
    otpType,
    destination,
    mobile,
    otp,
    verified: false,
    requestId,
    msg91Response,
    status,
    flow,
  };

  try {
    const record = await otpRepository.createOtpRecord(payload);
    console.log('OTP Stored: YES');
    console.log('Database Success: YES');
    return record;
  } catch (error) {
    console.log('Database Failure: YES');
    logErrorSection('OTP DATABASE ERROR', {
      timestamp: nowIso(),
      message: error.message,
      stack: error.stack,
      mobile,
      requestId,
    });
    throw new Error('OTP_DB_SAVE_FAILED');
  }
}

async function sendMobileOtp({ mobile, flow = 'GENERAL', businessId = null, otpType = 'MOBILE', destination = null, route = '/api/v1/auth/send-otp' }) {
  const timestamp = nowIso();
  const requestId = randomUUID();

  divider('OTP REQUEST START');
  logContext({ mobile, timestamp, requestId, route });

  let normalizedMobile;
  try {
    normalizedMobile = ensureMobile(mobile);
    const otp = generateOtp();
    console.log(`Generated OTP: ${otp}`);

    divider('VALIDATION');
    console.log('Validation Passed: YES');

    const record = await createOtpRecord({
      businessId,
      otpType,
      destination: destination || normalizedMobile,
      mobile: normalizedMobile,
      otp,
      flow,
      requestId,
      status: 'GENERATED',
      msg91Response: null,
    });

    rememberDevOtp(String(businessId || normalizedMobile), otpType, otp, normalizedMobile);

    const msg91Result = await sendMsg91Otp({ mobile: normalizedMobile, otp, requestId, route });
    await otpRepository.updateOtpRecord(record._id, {
      status: msg91Result.status,
      requestId: msg91Result.requestId,
      msg91Response: msg91Result.msg91Response,
    });

    summary('OTP FLOW SUMMARY', [
      '✓ Mobile Validation',
      '✓ OTP Generated',
      '✓ Database Saved',
      '✓ MSG91 Request Created',
      '✓ MSG91 Accepted',
      '✓ DLT Validation Passed',
      '✓ SMS Queued',
    ]);

    return {
      success: true,
      mobile: normalizedMobile,
      requestId: msg91Result.requestId,
      status: 'SENT',
      flow,
      message: 'OTP sent successfully',
    };
  } catch (error) {
    if (normalizedMobile) {
      try {
        const latest = await otpRepository.findLatestByMobile(normalizedMobile);
        if (latest && String(latest.requestId) === String(requestId)) {
          await otpRepository.updateOtpRecord(latest._id, {
            status: 'FAILED',
            msg91Response: error.msg91Response || { message: error.message },
          });
        }
      } catch (dbError) {
        logErrorSection('OTP DATABASE FAILURE (POST-MSG91)', {
          timestamp: nowIso(),
          route,
          requestId,
          mobile: normalizedMobile,
          message: dbError.message,
          stack: dbError.stack,
        });
      }
    }

    logErrorSection('OTP REQUEST ERROR', {
      timestamp: nowIso(),
      route,
      requestId,
      mobile: normalizedMobile || mobile,
      message: error.message,
      stack: error.stack,
      msg91Response: error.msg91Response,
    });

    summary('OTP FLOW SUMMARY', [
      '✓ Mobile Validation',
      '✓ OTP Generated',
      '✓ Database Saved',
      '✓ MSG91 Request Created',
      '✗ MSG91 Failed',
      `Failure Code: ${error.message}`,
      `Failure Reason: ${error.msg91Response ? JSON.stringify(error.msg91Response) : error.message}`,
    ]);

    throw error;
  }
}

async function verifyOtpByMobile({ mobile, otp, route = '/api/v1/auth/verify-otp' }) {
  const timestamp = nowIso();
  const requestId = randomUUID();

  divider('OTP VERIFY');
  logContext({ mobile, timestamp, requestId, route });

  const normalizedMobile = ensureMobile(mobile);
  const latest = await otpRepository.findLatestByMobile(normalizedMobile);

  if (!latest) {
    console.log('OTP Found: NO');
    throw new Error('OTP_NOT_FOUND');
  }

  console.log('OTP Found: YES');

  if (String(latest.otp) !== String(otp)) {
    console.log('OTP Invalid: YES');
    throw new Error('OTP_INVALID');
  }

  if (latest.verified) {
    console.log('OTP Already Verified: YES');
    return {
      verified: true,
      alreadyVerified: true,
      mobile: normalizedMobile,
      requestId: latest.requestId,
      status: latest.status,
    };
  }

  latest.verified = true;
  latest.status = 'VERIFIED';
  await latest.save();

  console.log('OTP Matched: YES');

  return {
    verified: true,
    alreadyVerified: false,
    mobile: normalizedMobile,
    requestId: latest.requestId,
    status: latest.status,
  };
}

async function verifyOtp(businessId, otpType, otp) {
  const record = await otpRepository.findLatestByBusinessAndType(businessId, otpType);

  if (!record) {
    throw new Error('OTP_NOT_FOUND');
  }

  if (String(record.otp) !== String(otp)) {
    throw new Error('OTP_INVALID');
  }

  if (!record.verified) {
    record.verified = true;
    record.status = 'VERIFIED';
    await record.save();
  }

  return true;
}

async function sendPhoneOtp(businessId, phone) {
  return sendMobileOtp({
    businessId,
    mobile: phone,
    flow: 'SIGNUP',
    otpType: 'PHONE',
    destination: phone,
    route: '/api/v1/auth/business/contact-details',
  });
}

module.exports = {
  sendMobileOtp,
  verifyOtpByMobile,
  sendPhoneOtp,
  verifyOtp,
  getDevOtps,
};

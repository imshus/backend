const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { normalizeIndianMobile } = require('./phone');

/**
 * Proof that the number an owner is adding (or moving an employee to) took
 * the OTP sent to it: issued by POST /employees/phone-otp/verify and carried
 * back on the request that writes the number. It names one shop and one
 * number, so it is no use to another shop or for another number, and lasts
 * long enough to finish the remaining screens (MPIN, permissions).
 */

const TYP = 'employee-phone';
const TTL_SECONDS = 30 * 60;

function signEmployeePhoneToken({ businessId, phone }) {
  return jwt.sign(
    { typ: TYP, businessId: String(businessId), phone: normalizeIndianMobile(phone) },
    config.jwt.accessSecret,
    { expiresIn: TTL_SECONDS },
  );
}

/** Whether `token` is a live proof for this shop and this number. */
function isEmployeePhoneVerified(token, { businessId, phone }) {
  const tenDigits = normalizeIndianMobile(phone);
  if (!token || typeof token !== 'string' || !tenDigits || !businessId) return false;
  try {
    const payload = jwt.verify(token, config.jwt.accessSecret, { algorithms: ['HS256'] });
    return payload?.typ === TYP
      && String(payload.businessId) === String(businessId)
      && payload.phone === tenDigits;
  } catch {
    return false;
  }
}

module.exports = {
  EMPLOYEE_PHONE_TOKEN_TTL_SECONDS: TTL_SECONDS,
  signEmployeePhoneToken,
  isEmployeePhoneVerified,
};

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { toPlainPermissions } = require('../utils/permissions');

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Seconds from now until the next midnight in India (Asia/Kolkata), never under a minute. */
const secondsUntilIstMidnight = (now = Date.now()) => {
  const istNow = now + IST_OFFSET_MS;
  const istNextMidnight = (Math.floor(istNow / 86_400_000) + 1) * 86_400_000;
  return Math.max(60, Math.round((istNextMidnight - IST_OFFSET_MS - now) / 1000));
};

/**
 * Every session ends at 12:00 AM India time — the shop's rule, and it holds
 * whether the app is open, in the background or closed, on every device.
 * The refresh token expires at the coming midnight instead of a week out,
 * and the access token at fifteen minutes or midnight, whichever is first.
 * Past midnight the first request is refused, the refresh is refused, and
 * the app drops to Log In.
 *
 * `claims` adds to the payload and can never replace the three that decide
 * who the token is: an employee's token carries a copy of their permissions,
 * re-read from the Employee document at every refresh. Access checks still
 * read that document, so a permission the owner takes away is gone at once.
 */
const generateTokens = (businessId, userId, role, claims = {}) => {
  const payload = { ...claims, businessId, userId, role };
  const untilMidnight = secondsUntilIstMidnight();

  const accessToken = jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: Math.min(15 * 60, untilMidnight),
  });
  const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: untilMidnight });

  return { accessToken, refreshToken };
};

const generatePasswordResetToken = (businessId, userId, nonce) => {
  return jwt.sign(
    { businessId, userId, nonce, purpose: 'PASSWORD_RESET' },
    config.jwt.accessSecret,
    { expiresIn: '10m' },
  );
};

const verifyPasswordResetToken = (token) => {
  try {
    const payload = jwt.verify(token, config.jwt.accessSecret);
    if (payload.purpose !== 'PASSWORD_RESET' || !payload.userId || !payload.nonce) {
      throw new Error('INVALID_RESET_TOKEN');
    }
    return payload;
  } catch (error) {
    if (error.message === 'INVALID_RESET_TOKEN') throw error;
    if (error.name === 'TokenExpiredError') throw new Error('RESET_TOKEN_EXPIRED');
    throw new Error('INVALID_RESET_TOKEN');
  }
};

const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, config.jwt.accessSecret);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('TOKEN_EXPIRED');
    }
    throw new Error('UNAUTHORIZED');
  }
};

const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, config.jwt.refreshSecret);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('REFRESH_TOKEN_EXPIRED');
    }
    throw new Error('UNAUTHORIZED');
  }
};

/**
 * A refresh is where a deactivated or deleted account is caught: the access
 * token lives fifteen minutes, so refusing here ends the session within that
 * long, instead of a refresh token re-minting one for a week on its own.
 */
const refreshTokens = async (token) => {
  const payload = verifyRefreshToken(token);
  const role = String(payload.role || '').trim().toUpperCase();
  if (role === 'EMP') {
    const Employee = require('../models/employee.model');
    const employee = await Employee.findById(payload.userId).select('isActive businessId permissions').lean();
    if (!employee || employee.isActive === false || String(employee.businessId) !== String(payload.businessId)) {
      throw new Error('UNAUTHORIZED');
    }
    // The permissions copy follows the Employee document, so an edit by the
    // owner reaches the token at its next refresh.
    return generateTokens(payload.businessId, payload.userId, payload.role, {
      permissions: toPlainPermissions(employee.permissions),
    });
  } else if (role === 'OWNER') {
    const BusinessUser = require('../models/businessUser.model');
    const user = await BusinessUser.findById(payload.userId).select('isActive businessId role').lean();
    if (
      !user
      || user.isActive === false
      || String(user.businessId) !== String(payload.businessId)
      // An employee's sign-in record is never an owner, whatever a token says.
      || String(user.role || '').toUpperCase() === 'EMP'
    ) {
      throw new Error('UNAUTHORIZED');
    }
  }
  return generateTokens(payload.businessId, payload.userId, payload.role);
};

module.exports = {
  generateTokens,
  generatePasswordResetToken,
  verifyPasswordResetToken,
  verifyAccessToken,
  verifyRefreshToken,
  refreshTokens,
};

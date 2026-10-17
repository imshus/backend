const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { toPlainPermissions } = require('../utils/permissions');

/**
 * A session no longer ends at 12:00 AM (the owner's call, 16 Oct 2026: the
 * daily sign-out and MPIN again after midnight are gone). The access token
 * lives fifteen minutes and the refresh token thirty days; every refresh
 * issues a new pair, so a phone used at least once a month stays signed in.
 *
 * `claims` adds to the payload and can never replace the three that decide
 * who the token is: an employee's token carries a copy of their permissions,
 * re-read from the Employee document at every refresh, and of its
 * sessionVersion. Access checks still read that document, so a permission
 * the owner takes away is gone at once.
 */
const generateTokens = (businessId, userId, role, claims = {}) => {
  const payload = { ...claims, businessId, userId, role };

  const accessToken = jwt.sign(payload, config.jwt.accessSecret, { expiresIn: '15m' });
  const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: '30d' });

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

/**
 * A session, and only a session. Other tokens are signed with the same secret
 * (the password-reset and profile-edit tokens, the employee-phone proof); each
 * says what it is for (`purpose`, `typ`), so none of them is ever let in as a
 * sign-in, nor outlives the midnight that ends every real one. A session
 * always names its user. (A missing or unknown role is the route's to refuse.)
 */
const verifyAccessToken = (token) => {
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.accessSecret);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('TOKEN_EXPIRED');
    }
    throw new Error('UNAUTHORIZED');
  }
  if (!payload || payload.typ || payload.purpose || !payload.userId) {
    throw new Error('UNAUTHORIZED');
  }
  return payload;
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

/** The Employee document's sessionVersion, or a token's copy of it; missing is 0. */
const sessionVersionOf = (holder) => Number(holder?.sessionVersion) || 0;

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
    const employee = await Employee.findById(payload.userId)
      .select('isActive businessId permissions sessionVersion')
      .lean();
    if (
      !employee
      || employee.isActive === false
      || String(employee.businessId) !== String(payload.businessId)
      // Issued before the employee deleted their account: over for good,
      // even once their owner switches them back on.
      || sessionVersionOf(payload) !== sessionVersionOf(employee)
    ) {
      throw new Error('UNAUTHORIZED');
    }
    // The permissions copy follows the Employee document, so an edit by the
    // owner reaches the token at its next refresh.
    return generateTokens(payload.businessId, payload.userId, payload.role, {
      permissions: toPlainPermissions(employee.permissions),
      sessionVersion: sessionVersionOf(employee),
    });
  } else if (role === 'OWNER' || role === 'SUPER') {
    // A SUPER account can delete itself too (DELETE /auth/account), so its
    // record is read the same way.
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
  sessionVersionOf,
  generateTokens,
  generatePasswordResetToken,
  verifyPasswordResetToken,
  verifyAccessToken,
  verifyRefreshToken,
  refreshTokens,
};

const jwt = require('jsonwebtoken');
const config = require('../config/env');

const generateTokens = (businessId, userId, role) => {
  const payload = { businessId, userId, role };

  const accessToken = jwt.sign(payload, config.jwt.accessSecret, { expiresIn: '15m' });
  const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: '7d' });

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
    const employee = await Employee.findById(payload.userId).select('isActive businessId').lean();
    if (!employee || employee.isActive === false || String(employee.businessId) !== String(payload.businessId)) {
      throw new Error('UNAUTHORIZED');
    }
  } else if (role === 'OWNER') {
    const BusinessUser = require('../models/businessUser.model');
    const user = await BusinessUser.findById(payload.userId).select('isActive businessId').lean();
    if (!user || user.isActive === false || String(user.businessId) !== String(payload.businessId)) {
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

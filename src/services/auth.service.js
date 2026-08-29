const jwt = require('jsonwebtoken');
const config = require('../config/env');

const generateTokens = (businessId, userId, role) => {
  const payload = { businessId, userId, role };

  const accessToken = jwt.sign(payload, config.jwt.accessSecret, { expiresIn: '15m' });
  const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: '7d' });

  return { accessToken, refreshToken };
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

const refreshTokens = (token) => {
  const payload = verifyRefreshToken(token);
  return generateTokens(payload.businessId, payload.userId, payload.role);
};

module.exports = {
  generateTokens,
  verifyAccessToken,
  verifyRefreshToken,
  refreshTokens,
};

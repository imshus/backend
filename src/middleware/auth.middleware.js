const authService = require('../services/auth.service');

const normalizeRole = (role) => String(role || '').trim().toUpperCase();
const SUPER_ROLES = new Set(['SUPER', 'SUPER_ADMIN', 'SUPERADMIN', 'SUPER ADMIN']);

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Missing or invalid token format' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = authService.verifyAccessToken(token);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Token is invalid or expired' });
  }
};

const authenticateJWTOptional = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = authService.verifyAccessToken(token);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Token is invalid or expired' });
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You do not have permission to perform this action' });
    }

    const userRole = normalizeRole(req.user.role);
    const allowedRoles = roles.map(normalizeRole);

    if (SUPER_ROLES.has(userRole)) {
      return next();
    }

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You do not have permission to perform this action' });
    }
    next();
  };
};

module.exports = {
  authenticateJWT,
  authenticateJWTOptional,
  requireRole
};

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

/**
 * Lets an OWNER or SUPER token through only while its sign-in record is still
 * there: in that shop, not an employee's, not switched off — the same test a
 * refresh makes.
 */
const requireCurrentRecord = async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const BusinessUser = require('../models/businessUser.model');
    const { userId, businessId } = req.user;
    const current = mongoose.isValidObjectId(String(userId))
      && mongoose.isValidObjectId(String(businessId))
      && await BusinessUser.exists({ _id: userId, businessId, role: { $ne: 'EMP' }, isActive: { $ne: false } });
    if (!current) {
      return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Your session has ended. Please sign in again.' });
    }
  } catch (error) {
    return next(error);
  }
  return next();
};

/**
 * An OWNER (or SUPER) token counts only while its sign-in record is still
 * there (requireCurrentRecord). An access token outlives its record by up to
 * fifteen minutes, and an owner made someone's employee, or anyone who
 * deleted their account, loses theirs at once (released_logins), so the
 * routes that cannot be undone — deleting the account, managing the roster —
 * read the record first. Other roles pass on; requireRole decides them.
 */
const requireCurrentOwner = (req, res, next) => {
  const role = normalizeRole(req.user?.role);
  if (role !== 'OWNER' && !SUPER_ROLES.has(role)) return next();
  return requireCurrentRecord(req, res, next);
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You do not have permission to perform this action' });
    }

    const userRole = normalizeRole(req.user.role);
    const allowedRoles = roles.map(normalizeRole);

    // A SUPER token passes every role check (the credit and supreme-rate
    // routes are its alone), so it counts only while its record is there: a
    // SUPER account that deleted itself loses them at once, not when its
    // access token runs out.
    if (SUPER_ROLES.has(userRole)) {
      return requireCurrentRecord(req, res, next);
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
  requireCurrentOwner,
  requireRole
};

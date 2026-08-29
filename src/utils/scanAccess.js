function assertScanAccess(scan, session = {}) {
  if (!scan) {
    const err = new Error('Scan not found');
    err.statusCode = 404;
    throw err;
  }

  const hasSession = Boolean(session && (session.userId || session.businessId));
  if (!hasSession) {
    return scan;
  }

  if (scan.businessId && session.businessId && String(scan.businessId) !== String(session.businessId)) {
    const err = new Error('Unauthorized scan access (business mismatch)');
    err.statusCode = 403;
    throw err;
  }

  if (scan.ownerUserId && session.userId && String(scan.ownerUserId) !== String(session.userId)) {
    const err = new Error('Unauthorized scan access (user mismatch)');
    err.statusCode = 403;
    throw err;
  }

  return scan;
}

function toSessionContext(user) {
  if (!user) return {};
  return {
    userId: user.userId,
    businessId: user.businessId,
    role: user.role,
  };
}

module.exports = {
  assertScanAccess,
  toSessionContext,
};

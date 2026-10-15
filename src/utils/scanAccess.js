/**
 * A scan id with no record: never created, or dropped because the scan is
 * over (scanStore). 404 SCAN_EXPIRED, "Please scan again" (errorHandler). The
 * words keep "Scan not found", which the review card of every build already
 * reads as a stale scan.
 */
function scanExpiredError() {
  const err = new Error('SCAN_EXPIRED');
  err.statusCode = 404;
  return err;
}

function assertScanAccess(scan, session = {}) {
  if (!scan) {
    throw scanExpiredError();
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
  scanExpiredError,
  toSessionContext,
};

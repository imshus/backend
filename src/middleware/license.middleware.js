const licenseService = require('../services/license.service');
const walletService = require('../services/wallet.service');

async function attachLicenseContext(req, res, next) {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      const err = new Error('UNAUTHORIZED');
      err.statusCode = 401;
      throw err;
    }

    // Independent reads; running them together shaves a round trip off every
    // scanner call — including the MRP calculation the review card waits on.
    const [overview, wallet] = await Promise.all([
      licenseService.getLicenseOverview(businessId),
      walletService.ensureWallet(businessId),
    ]);

    // The number the licence is held under: the owner's account, which is how
    // a shop knows itself. Not necessarily the number of whoever is signed in
    // — an employee inherits their shop's licence, and their own phone holds
    // none — so the licence is still reached through the account above rather
    // than looked up by the caller's number.
    const ownerPhone = overview.license?.ownerPhone || '';

    req.licenseContext = {
      businessId,
      ownerPhone,
      ...overview,
      wallet,
    };

    // Phone first: it is what a shop is identified by when someone asks why
    // their scanner stopped. businessId stays at the end because every other
    // line in these logs, and every collection, is keyed by it — without it a
    // licence line cannot be joined to the scan it gated.
    console.info('[LICENSE_VERIFIED]', {
      phone: ownerPhone || '(not recorded)',
      licenseStatus: overview.licenseStatus,
      walletEnabled: overview.walletEnabled,
      scannerEnabled: overview.scannerEnabled,
      businessId: String(businessId),
    });

    next();
  } catch (error) {
    next(error);
  }
}

function requireTrialOrLicense(req, res, next) {
  const ctx = req.licenseContext;
  if (!ctx) {
    const err = new Error('LICENSE_CONTEXT_MISSING');
    err.statusCode = 500;
    return next(err);
  }

  if (ctx.hasActiveLicense) {
    return next();
  }

  const err = new Error('LICENSE_REQUIRED');
  err.statusCode = 403;
  return next(err);
}

function requireLicense(req, res, next) {
  const ctx = req.licenseContext;
  if (!ctx) {
    const err = new Error('LICENSE_CONTEXT_MISSING');
    err.statusCode = 500;
    return next(err);
  }

  if (ctx.licenseStatus === 'PERMANENT_LICENSE') {
    return next();
  }

  const err = new Error('PERMANENT_LICENSE_REQUIRED');
  err.statusCode = 403;
  return next(err);
}

function requireWallet(req, res, next) {
  const ctx = req.licenseContext;
  if (!ctx) {
    const err = new Error('LICENSE_CONTEXT_MISSING');
    err.statusCode = 500;
    return next(err);
  }

  if (!ctx.walletEnabled) {
    const err = new Error('WALLET_DISABLED_FOR_LICENSE');
    err.statusCode = 403;
    return next(err);
  }

  return next();
}

function requireScannerAccess(req, res, next) {
  const ctx = req.licenseContext;
  if (!ctx) {
    const err = new Error('LICENSE_CONTEXT_MISSING');
    err.statusCode = 500;
    return next(err);
  }

  if (!ctx.scannerEnabled) {
    const err = new Error('SCANNER_LICENSE_REQUIRED');
    err.statusCode = 403;
    return next(err);
  }

  if (Number(ctx.wallet.creditBalance || 0) <= 0) {
    const err = new Error('NO_CREDITS_AVAILABLE');
    err.statusCode = 402;
    return next(err);
  }

  return next();
}

module.exports = {
  attachLicenseContext,
  requireLicense,
  requireTrialOrLicense,
  requireWallet,
  requireScannerAccess,
};

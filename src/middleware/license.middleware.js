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

    const overview = await licenseService.getLicenseOverview(businessId);
    const wallet = await walletService.ensureWallet(businessId);

    req.licenseContext = {
      businessId,
      ...overview,
      wallet,
    };

    console.info('[LICENSE_VERIFIED]', {
      businessId: String(businessId),
      licenseStatus: overview.licenseStatus,
      walletEnabled: overview.walletEnabled,
      scannerEnabled: overview.scannerEnabled,
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

const OrganizationLicense = require('../models/organizationLicense.model');
const billingConfigService = require('./billingConfig.service');
const walletService = require('./wallet.service');

function addDays(baseDate, days) {
  const cloned = new Date(baseDate);
  cloned.setUTCDate(cloned.getUTCDate() + days);
  return cloned;
}

function hasActiveLicense(license) {
  return (
    license.licenseStatus === 'FREE_TRIAL_LICENSE'
    || license.licenseStatus === 'PERMANENT_LICENSE'
  );
}

function isPermanentLicense(license) {
  return license.licenseStatus === 'PERMANENT_LICENSE';
}

function canUseWallet(license) {
  return true;
}

function canUseScanner(license) {
  return hasActiveLicense(license);
}

function canRechargeCredits(license) {
  return isPermanentLicense(license);
}

function canAccessPaymentHistory(license) {
  return isPermanentLicense(license);
}

async function ensureLicense(businessId) {
  const cfg = await billingConfigService.getEffectiveConfig();
  let license = await OrganizationLicense.findOne({ businessId });

  if (!license) {
    license = await OrganizationLicense.create({
      businessId,
      licenseStatus: 'NO_LICENSE',
      trialDays: Number(cfg.trialDays || 10),
      trialCredits: Number(cfg.freeTrialCredits || 100),
    });
    console.info('[LICENSE_CREATED]', {
      businessId: String(businessId),
      licenseStatus: 'NO_LICENSE',
    });
  }

  return syncLicenseState(license);
}

async function syncLicenseState(license) {
  if (!license) return license;

  if (
    license.licenseStatus === 'FREE_TRIAL_LICENSE'
    && license.trialEndDate
    && new Date() > new Date(license.trialEndDate)
  ) {
    license.licenseStatus = 'NO_LICENSE';
    license.trialExpiredAt = new Date();
    await license.save();

    const wallet = await walletService.ensureWallet(license.businessId);
    if (Number(wallet.creditBalance || 0) > 0) {
      await walletService.setCredits({
        businessId: license.businessId,
        targetAmount: 0,
        type: 'TRIAL_EXPIRY_RESET',
        note: 'Trial expired; remaining trial credits discarded',
        metadata: {
          trialExpiredAt: license.trialExpiredAt,
        },
      });
    }

    console.info('[TRIAL_EXPIRED]', {
      businessId: String(license.businessId),
      trialEndDate: license.trialEndDate,
      trialExpiredAt: license.trialExpiredAt,
    });

    console.info('[WALLET_DISABLED]', {
      businessId: String(license.businessId),
      reason: 'TRIAL_EXPIRED',
    });
  }

  return license;
}

async function getLicenseOverview(businessId) {
  const license = await ensureLicense(businessId);
  const now = new Date();

  let trialDaysRemaining = 0;
  let trialHoursRemaining = 0;
  if (license.licenseStatus === 'FREE_TRIAL_LICENSE' && license.trialEndDate) {
    const ms = new Date(license.trialEndDate).getTime() - now.getTime();
    trialDaysRemaining = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
    trialHoursRemaining = Math.max(0, Math.ceil(ms / (60 * 60 * 1000)));
  }

  return {
    license,
    licenseStatus: license.licenseStatus,
    hasActiveLicense: hasActiveLicense(license),
    walletEnabled: canUseWallet(license),
    scannerEnabled: canUseScanner(license),
    rechargeEnabled: canRechargeCredits(license),
    paymentHistoryEnabled: canAccessPaymentHistory(license),
    trialDaysRemaining,
    trialHoursRemaining,
  };
}

async function startTrialLicense(businessId, actorUserId) {
  const cfg = await billingConfigService.getEffectiveConfig();
  const license = await ensureLicense(businessId);

  if (license.licenseStatus === 'PERMANENT_LICENSE') {
    return { license, started: false, reason: 'LICENSE_ALREADY_PERMANENT' };
  }

  if (license.trialExpiredAt) {
    return { license, started: false, reason: 'TRIAL_ALREADY_EXPIRED' };
  }

  if (license.licenseStatus === 'FREE_TRIAL_LICENSE') {
    return { license, started: false, reason: 'TRIAL_ALREADY_ACTIVE' };
  }

  const now = new Date();
  const trialDays = Number(cfg.trialDays || 10);
  const trialCredits = Number(cfg.freeTrialCredits || 100);

  license.licenseStatus = 'FREE_TRIAL_LICENSE';
  license.trialDays = trialDays;
  license.trialCredits = trialCredits;
  license.trialStartDate = now;
  license.trialEndDate = addDays(now, trialDays);
  await license.save();

  console.info('[TRIAL_STARTED]', {
    businessId: String(businessId),
    actorUserId: actorUserId || null,
    trialDays,
    trialCredits,
    trialStartDate: license.trialStartDate,
    trialEndDate: license.trialEndDate,
  });

  console.info('[WALLET_ENABLED]', {
    businessId: String(businessId),
    reason: 'TRIAL_LICENSE_ACTIVE',
  });

  return {
    license,
    started: true,
    trialCreditsToGrant: trialCredits,
  };
}

async function activatePermanentLicense({
  businessId,
  actorUserId,
  purchaseAmount,
  purchaseDate = new Date(),
  orderId = null,
  paymentId = null,
  invoiceNumber = null,
}) {
  const license = await ensureLicense(businessId);

  if (license.licenseStatus === 'PERMANENT_LICENSE') {
    return { license, activated: false, reason: 'LICENSE_ALREADY_PERMANENT' };
  }

  license.licenseStatus = 'PERMANENT_LICENSE';
  license.permanentActivatedAt = purchaseDate;
  license.purchaseDate = purchaseDate;
  license.purchaseAmount = Number(purchaseAmount || 0);
  license.purchaseOrderId = orderId;
  license.purchasePaymentId = paymentId;
  license.purchaseInvoiceNumber = invoiceNumber;
  await license.save();

  console.info('[LICENSE_ACTIVATED]', {
    businessId: String(businessId),
    actorUserId: actorUserId || null,
    purchaseAmount: license.purchaseAmount,
    purchaseDate,
    orderId,
    paymentId,
    invoiceNumber,
  });

  console.info('[WALLET_ENABLED]', {
    businessId: String(businessId),
    reason: 'PERMANENT_LICENSE_ACTIVE',
  });

  return { license, activated: true };
}

module.exports = {
  ensureLicense,
  syncLicenseState,
  getLicenseOverview,
  hasActiveLicense,
  isPermanentLicense,
  canUseWallet,
  canUseScanner,
  canRechargeCredits,
  canAccessPaymentHistory,
  startTrialLicense,
  activatePermanentLicense,
};

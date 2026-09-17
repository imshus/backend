const OrganizationLicense = require('../models/organizationLicense.model');
const BusinessUser = require('../models/businessUser.model');
const billingConfigService = require('./billingConfig.service');
const walletService = require('./wallet.service');
const referralService = require('./referral.service');

/**
 * Pays the referrer when a referred business takes its first licence. A
 * referral hiccup must never fail the licence action itself, so this only
 * logs on error.
 */
async function payReferralReward({ businessId, trigger, orderId = null, paymentId = null }) {
  try {
    await referralService.rewardReferrerIfEligible({ businessId, trigger, orderId, paymentId });
  } catch (error) {
    console.error('[REFERRAL_REWARD_FAILED]', {
      businessId: String(businessId),
      trigger,
      error: error?.message || String(error),
    });
  }
}

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

/**
 * The account a licence belongs to: the shop's owner. The earliest one, for
 * the handful of shops that collected a second owner while one GSTIN meant one
 * business.
 */
async function resolveOwnerAccount(businessId) {
  return BusinessUser.findOne({ businessId, role: 'OWNER' })
    .sort({ createdAt: 1 })
    .select('phone')
    .lean();
}

async function ensureLicense(businessId) {
  const cfg = await billingConfigService.getEffectiveConfig();
  let license = await OrganizationLicense.findOne({ businessId });

  // Looked up before the licence is written so a new one carries its owner
  // from the start, and an older one missing it is filled in on this read.
  const owner = license?.ownerUserId && license?.ownerPhone
    ? null
    : await resolveOwnerAccount(businessId);

  if (!license) {
    license = await OrganizationLicense.create({
      businessId,
      ownerUserId: owner?._id ?? null,
      ownerPhone: owner?.phone || '',
      licenseStatus: 'NO_LICENSE',
      trialDays: Number(cfg.trialDays || 7),
      trialCredits: Number(cfg.freeTrialCredits || 10),
    });
    console.info('[LICENSE_CREATED]', {
      phone: license.ownerPhone || '(not recorded)',
      licenseStatus: 'NO_LICENSE',
      businessId: String(businessId),
    });
  } else if (owner) {
    license.ownerUserId = owner._id;
    license.ownerPhone = owner.phone || '';
    await license.save();
  }

  return syncLicenseState(license);
}

/**
 * The licence reached on a mobile number — what support is asked for, since a
 * shop knows its phone number and not its businessId.
 *
 * A number identifies one account (phones are unique on business_users), so it
 * identifies one licence. Licences written before the owner was recorded are
 * found through the account instead, and recorded on the way past.
 */
async function findLicenseByPhone(phone) {
  const normalized = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!normalized) return null;

  const license = await OrganizationLicense.findOne({ ownerPhone: normalized });
  if (license) return syncLicenseState(license);

  const owner = await BusinessUser.findOne({ phone: normalized, role: 'OWNER' });
  if (!owner) return null;
  return ensureLicense(owner.businessId);
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
      phone: license.ownerPhone || '(not recorded)',
      trialEndDate: license.trialEndDate,
      trialExpiredAt: license.trialExpiredAt,
      businessId: String(license.businessId),
    });

    console.info('[WALLET_DISABLED]', {
      phone: license.ownerPhone || '(not recorded)',
      reason: 'TRIAL_EXPIRED',
      businessId: String(license.businessId),
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
  const trialDays = Number(cfg.trialDays || 7);
  const trialCredits = Number(cfg.freeTrialCredits || 10);

  license.licenseStatus = 'FREE_TRIAL_LICENSE';
  license.trialDays = trialDays;
  license.trialCredits = trialCredits;
  license.trialStartDate = now;
  license.trialEndDate = addDays(now, trialDays);
  await license.save();

  console.info('[TRIAL_STARTED]', {
    phone: license.ownerPhone || '(not recorded)',
    businessId: String(businessId),
    actorUserId: actorUserId || null,
    trialDays,
    trialCredits,
    trialStartDate: license.trialStartDate,
    trialEndDate: license.trialEndDate,
  });

  console.info('[WALLET_ENABLED]', {
    phone: license.ownerPhone || '(not recorded)',
    reason: 'TRIAL_LICENSE_ACTIVE',
    businessId: String(businessId),
  });

  await payReferralReward({ businessId, trigger: 'TRIAL_STARTED' });

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
    phone: license.ownerPhone || '(not recorded)',
    businessId: String(businessId),
    actorUserId: actorUserId || null,
    purchaseAmount: license.purchaseAmount,
    purchaseDate,
    orderId,
    paymentId,
    invoiceNumber,
  });

  console.info('[WALLET_ENABLED]', {
    phone: license.ownerPhone || '(not recorded)',
    reason: 'PERMANENT_LICENSE_ACTIVE',
    businessId: String(businessId),
  });

  await payReferralReward({ businessId, trigger: 'LICENSE_PURCHASED' });

  return { license, activated: true };
}

module.exports = {
  ensureLicense,
  findLicenseByPhone,
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

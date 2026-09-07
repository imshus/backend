const crypto = require('crypto');

const Business = require('../models/business.model');
const CreditTransaction = require('../models/creditTransaction.model');
const walletService = require('./wallet.service');

/** Credits the referrer earns when a business they referred takes a licence. */
const REFERRAL_BONUS_CREDITS = 100;

/** No 0/O, 1/I/L: every code survives being read out loud or hand-copied. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const defaultDeps = { Business, CreditTransaction, walletService };

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** Uppercases and strips separators so "mrp-7k2m4x" matches the stored code. */
function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Returns the business's shareable code, generating and saving one on first use. */
async function ensureReferralCode(businessId, deps = defaultDeps) {
  const business = await deps.Business.findById(businessId);
  if (!business) throw new Error('BUSINESS_NOT_FOUND');
  if (business.referralCode) return business.referralCode;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    business.referralCode = generateCode();
    try {
      await business.save();
      return business.referralCode;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      // Another business drew the same code; draw again.
    }
  }
  throw new Error('REFERRAL_CODE_GENERATION_FAILED');
}

/**
 * Records who referred a registering business. Called from the registration
 * flow, so an unknown code must fail loudly there — the person typing it can
 * still fix it. Re-submitting the same step with a new code re-points the
 * referral; that is fine before any reward has been paid.
 */
async function applyReferralCode({ businessId, code }, deps = defaultDeps) {
  const normalized = normalizeCode(code);
  if (!normalized) return { applied: false };

  const referrer = await deps.Business.findOne({ referralCode: normalized });
  if (!referrer || String(referrer._id) === String(businessId)) {
    throw new Error('REFERRAL_CODE_INVALID');
  }

  const business = await deps.Business.findById(businessId);
  if (!business) throw new Error('REGISTRATION_SESSION_EXPIRED');
  if (business.referralRewardedAt) return { applied: false };

  business.referredByBusinessId = referrer._id;
  await business.save();

  console.info('[REFERRAL_LINKED]', {
    businessId: String(businessId),
    referrerBusinessId: String(referrer._id),
    code: normalized,
  });

  return { applied: true, referrerBusinessId: referrer._id };
}

/**
 * Pays the referrer once, the first time the referred business takes a
 * licence (free trial or purchase). Idempotent: the referralRewardedAt stamp
 * and a transaction lookup both guard against double payment.
 */
async function rewardReferrerIfEligible(
  { businessId, trigger, orderId = null, paymentId = null, source = 'license.service' },
  deps = defaultDeps,
) {
  const business = await deps.Business.findById(businessId);
  if (!business || !business.referredByBusinessId || business.referralRewardedAt) {
    return { rewarded: false };
  }

  const alreadyPaid = await deps.CreditTransaction.findOne({
    type: 'REFERRAL_BONUS',
    'metadata.referredBusinessId': String(businessId),
  });
  if (!alreadyPaid) {
    await deps.walletService.addCredits({
      businessId: business.referredByBusinessId,
      amount: REFERRAL_BONUS_CREDITS,
      type: 'REFERRAL_BONUS',
      note: `Referral reward: ${business.tradeName || 'a referred business'} activated a licence`,
      metadata: {
        referredBusinessId: String(businessId),
        trigger,
        orderId,
        paymentId,
        source,
      },
    });
  }

  business.referralRewardedAt = new Date();
  await business.save();

  console.info('[REFERRAL_REWARDED]', {
    referrerBusinessId: String(business.referredByBusinessId),
    referredBusinessId: String(businessId),
    credits: REFERRAL_BONUS_CREDITS,
    trigger,
  });

  return { rewarded: !alreadyPaid, credits: REFERRAL_BONUS_CREDITS };
}

/** Everything the Earn & Invite screen shows. */
async function getReferralOverview(businessId, deps = defaultDeps) {
  const referralCode = await ensureReferralCode(businessId, deps);
  const invitedCount = await deps.Business.countDocuments({
    referredByBusinessId: businessId,
    isRegistered: true,
  });
  const rewardedCount = await deps.Business.countDocuments({
    referredByBusinessId: businessId,
    referralRewardedAt: { $ne: null },
  });

  return {
    referralCode,
    creditsPerReferral: REFERRAL_BONUS_CREDITS,
    invitedCount,
    rewardedCount,
    pendingCount: Math.max(0, invitedCount - rewardedCount),
    creditsEarned: rewardedCount * REFERRAL_BONUS_CREDITS,
  };
}

module.exports = {
  REFERRAL_BONUS_CREDITS,
  generateCode,
  normalizeCode,
  ensureReferralCode,
  applyReferralCode,
  rewardReferrerIfEligible,
  getReferralOverview,
};

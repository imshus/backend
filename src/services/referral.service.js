const crypto = require('crypto');

const Business = require('../models/business.model');
const ReferralCode = require('../models/referralCode.model');
const CreditTransaction = require('../models/creditTransaction.model');
const walletService = require('./wallet.service');

/** Credits the referrer's business earns when a referred business takes a licence. */
const REFERRAL_BONUS_CREDITS = 100;

/** No 0/O, 1/I/L: every code survives being read out loud or hand-copied. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const defaultDeps = { Business, ReferralCode, CreditTransaction, walletService };

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

/**
 * Returns this person's own shareable code — the owner and every employee of
 * a business each carry one — generating and saving it on first use.
 */
async function ensureReferralCode({ businessId, userId }, deps = defaultDeps) {
  if (!businessId || !userId) throw new Error('REFERRAL_SCOPE_MISSING');

  const existing = await deps.ReferralCode.findOne({ businessId, userId });
  if (existing) return existing.code;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();
    try {
      const created = await deps.ReferralCode.create({ businessId, userId, code });
      return created.code;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      // Either another business drew the same code (draw again) or this very
      // person saved one in a parallel request (return it).
      const won = await deps.ReferralCode.findOne({ businessId, userId });
      if (won) return won.code;
    }
  }
  throw new Error('REFERRAL_CODE_GENERATION_FAILED');
}

/**
 * Records who referred a registering business — which business, and which of
 * its members' codes was used. Called from the registration flow, so an
 * unknown code must fail loudly there; the person typing it can still fix it.
 * Re-submitting the step with a new code re-points the referral; that is fine
 * before any reward has been paid.
 */
async function applyReferralCode({ businessId, code }, deps = defaultDeps) {
  const normalized = normalizeCode(code);
  if (!normalized) return { applied: false };

  const referrer = await deps.ReferralCode.findOne({ code: normalized });
  if (!referrer || String(referrer.businessId) === String(businessId)) {
    throw new Error('REFERRAL_CODE_INVALID');
  }

  const business = await deps.Business.findById(businessId);
  if (!business) throw new Error('REGISTRATION_SESSION_EXPIRED');
  if (business.referralRewardedAt) return { applied: false };

  business.referredByBusinessId = referrer.businessId;
  business.referredByUserId = referrer.userId;
  await business.save();

  console.info('[REFERRAL_LINKED]', {
    businessId: String(businessId),
    referrerBusinessId: String(referrer.businessId),
    referrerUserId: String(referrer.userId),
    code: normalized,
  });

  return { applied: true, referrerBusinessId: referrer.businessId, referrerUserId: referrer.userId };
}

/**
 * Pays the referrer's business once, the first time the referred business
 * takes a licence (free trial or purchase). The credit lands in the shop
 * wallet, attributed to the member whose code was used. Idempotent: the
 * referralRewardedAt stamp and a transaction lookup both guard against
 * double payment.
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
      userId: business.referredByUserId || null,
      amount: REFERRAL_BONUS_CREDITS,
      type: 'REFERRAL_BONUS',
      note: `Referral reward: ${business.tradeName || 'a referred business'} activated a licence`,
      metadata: {
        referredBusinessId: String(businessId),
        earnedByUserId: business.referredByUserId ? String(business.referredByUserId) : null,
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
    earnedByUserId: business.referredByUserId ? String(business.referredByUserId) : null,
    referredBusinessId: String(businessId),
    credits: REFERRAL_BONUS_CREDITS,
    trigger,
  });

  return { rewarded: !alreadyPaid, credits: REFERRAL_BONUS_CREDITS };
}

/** Everything the Earn & Invite screen shows, personal to the signed-in account. */
async function getReferralOverview({ businessId, userId }, deps = defaultDeps) {
  const referralCode = await ensureReferralCode({ businessId, userId }, deps);
  const mine = { referredByBusinessId: businessId, referredByUserId: userId };
  const invitedCount = await deps.Business.countDocuments({ ...mine, isRegistered: true });
  const rewardedCount = await deps.Business.countDocuments({ ...mine, referralRewardedAt: { $ne: null } });

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

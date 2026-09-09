const crypto = require('crypto');

const Business = require('../models/business.model');
const ReferralCode = require('../models/referralCode.model');
const CreditTransaction = require('../models/creditTransaction.model');
const walletService = require('./wallet.service');

/**
 * Two rewards, both to the referrer's shop wallet: one when the referred
 * business joins (its first licence, trial included), a larger one when it
 * purchases the application.
 */
const INVITE_REWARD_CREDITS = 50;
const PURCHASE_REWARD_CREDITS = 500;

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
  business.referredByCode = normalized;
  await business.save();

  console.info('[REFERRAL_LINKED]', {
    businessId: String(businessId),
    referrerBusinessId: String(referrer.businessId),
    referrerUserId: String(referrer.userId),
    code: normalized,
  });

  return { applied: true, referrerBusinessId: referrer.businessId, referrerUserId: referrer.userId };
}

/** One reward payment, guarded by its per-tier transaction lookup. */
async function payTier(business, businessId, tier, credits, extraMeta, deps) {
  const alreadyPaid = await deps.CreditTransaction.findOne({
    type: 'REFERRAL_BONUS',
    'metadata.referredBusinessId': String(businessId),
    'metadata.tier': tier,
  });
  if (alreadyPaid) return false;

  await deps.walletService.addCredits({
    businessId: business.referredByBusinessId,
    userId: business.referredByUserId || null,
    amount: credits,
    type: 'REFERRAL_BONUS',
    note:
      tier === 'PURCHASE'
        ? `Referral reward: ${business.tradeName || 'a referred business'} purchased the application`
        : `Referral reward: ${business.tradeName || 'a referred business'} joined MRPscan`,
    metadata: {
      referredBusinessId: String(businessId),
      earnedByUserId: business.referredByUserId ? String(business.referredByUserId) : null,
      tier,
      ...extraMeta,
    },
  });

  console.info('[REFERRAL_REWARDED]', {
    referrerBusinessId: String(business.referredByBusinessId),
    referredBusinessId: String(businessId),
    tier,
    credits,
  });
  return true;
}

/**
 * Pays the referrer's shop wallet in two tiers, each at most once per
 * referred business: the invite reward the first time it takes any licence
 * (trial included), and the purchase reward when it buys the application —
 * which also settles an unpaid invite reward, for a shop that bought without
 * ever starting the trial. Stamps on the business and per-tier transaction
 * lookups both guard against double payment.
 */
async function rewardReferrerIfEligible(
  { businessId, trigger, orderId = null, paymentId = null, source = 'license.service' },
  deps = defaultDeps,
) {
  const business = await deps.Business.findById(businessId);
  if (!business || !business.referredByBusinessId) {
    return { rewarded: false };
  }

  const extraMeta = { trigger, orderId, paymentId, source };
  let credits = 0;

  if (!business.referralRewardedAt) {
    if (await payTier(business, businessId, 'INVITE', INVITE_REWARD_CREDITS, extraMeta, deps)) {
      credits += INVITE_REWARD_CREDITS;
    }
    business.referralRewardedAt = new Date();
  }

  if (trigger === 'LICENSE_PURCHASED' && !business.referralPurchaseRewardedAt) {
    if (await payTier(business, businessId, 'PURCHASE', PURCHASE_REWARD_CREDITS, extraMeta, deps)) {
      credits += PURCHASE_REWARD_CREDITS;
    }
    business.referralPurchaseRewardedAt = new Date();
  }

  await business.save();
  return { rewarded: credits > 0, credits };
}

/** Everything the Earn & Invite screen shows, personal to the signed-in account. */
async function getReferralOverview({ businessId, userId }, deps = defaultDeps) {
  const referralCode = await ensureReferralCode({ businessId, userId }, deps);
  const mine = { referredByBusinessId: businessId, referredByUserId: userId };
  const invitedCount = await deps.Business.countDocuments({ ...mine, referralRewardedAt: { $ne: null } });
  const purchasedCount = await deps.Business.countDocuments({ ...mine, referralPurchaseRewardedAt: { $ne: null } });

  const inviteCredits = invitedCount * INVITE_REWARD_CREDITS;
  const purchaseCredits = purchasedCount * PURCHASE_REWARD_CREDITS;

  return {
    referralCode,
    inviteReward: INVITE_REWARD_CREDITS,
    purchaseReward: PURCHASE_REWARD_CREDITS,
    invitedCount,
    purchasedCount,
    inviteCredits,
    purchaseCredits,
    totalCredits: inviteCredits + purchaseCredits,
  };
}

module.exports = {
  INVITE_REWARD_CREDITS,
  PURCHASE_REWARD_CREDITS,
  generateCode,
  normalizeCode,
  ensureReferralCode,
  applyReferralCode,
  rewardReferrerIfEligible,
  getReferralOverview,
};

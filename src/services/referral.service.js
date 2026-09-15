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
 * Whose code this is, or null when none was typed. Throws on a code nobody
 * holds and on a shop's own code, so a registrant learns of a typo while the
 * form is still in front of them — call this BEFORE creating the account.
 */
async function resolveReferralCode({ businessId, code }, deps = defaultDeps) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  const referrer = await deps.ReferralCode.findOne({ code: normalized });
  if (!referrer || String(referrer.businessId) === String(businessId)) {
    throw new Error('REFERRAL_CODE_INVALID');
  }
  return { businessId: referrer.businessId, userId: referrer.userId, code: normalized };
}

/**
 * Writes the referral onto the registering business. Called at the moment a
 * registration completes — where the caller has proved control of the phone
 * number — so nobody else can decide who referred this shop.
 */
async function linkReferral({ businessId, referrer }, deps = defaultDeps) {
  if (!referrer) return { applied: false };

  const business = await deps.Business.findById(businessId);
  if (!business) throw new Error('REGISTRATION_SESSION_EXPIRED');
  // A reward has already been paid against this shop: the referral it was
  // paid for stands.
  if (business.referralRewardedAt) return { applied: false };

  business.referredByBusinessId = referrer.businessId;
  business.referredByUserId = referrer.userId;
  business.referredByCode = referrer.code;
  await business.save();

  console.info('[REFERRAL_LINKED]', {
    businessId: String(businessId),
    referrerBusinessId: String(referrer.businessId),
    referrerUserId: String(referrer.userId),
    code: referrer.code,
  });

  return { applied: true, referrerBusinessId: referrer.businessId, referrerUserId: referrer.userId };
}

/** Validates a code and links it in one step. */
async function applyReferralCode({ businessId, code }, deps = defaultDeps) {
  const referrer = await resolveReferralCode({ businessId, code }, deps);
  if (!referrer) return { applied: false };
  return linkReferral({ businessId, referrer }, deps);
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

/** The stamp that says a tier has been settled for a referred business. */
const TIER_STAMP = { INVITE: 'referralRewardedAt', PURCHASE: 'referralPurchaseRewardedAt' };
const TIER_CREDITS = { INVITE: INVITE_REWARD_CREDITS, PURCHASE: PURCHASE_REWARD_CREDITS };

/**
 * Takes the tier for this business, or reports that something else already
 * has it.
 *
 * The stamp is set only if it was unset, in one atomic update. Reading the
 * ledger and then paying is not enough on its own: a purchase that also
 * activates the licence, or a webhook delivered twice, puts two of these in
 * flight at once and both would find nothing paid — and the wallet balance is
 * written before the ledger row exists, so a unique index would catch the
 * second one only after the credits had moved.
 */
async function claimTier(businessId, tier, deps) {
  const field = TIER_STAMP[tier];
  const claimed = await deps.Business.findOneAndUpdate(
    { _id: businessId, $or: [{ [field]: null }, { [field]: { $exists: false } }] },
    { $set: { [field]: new Date() } },
  );
  return Boolean(claimed);
}

/** Gives a tier back, so a payment that failed can be retried later. */
async function releaseTier(businessId, tier, deps) {
  await deps.Business.updateOne({ _id: businessId }, { $set: { [TIER_STAMP[tier]]: null } });
}

/**
 * Pays the referrer's shop wallet in two tiers, each at most once per
 * referred business: the invite reward the first time it takes any licence
 * (trial included), and the purchase reward when it buys the application —
 * which also settles an unpaid invite reward, for a shop that bought without
 * ever starting the trial. The tier is claimed before anything is paid, and
 * given back when the payment fails; the ledger lookup in payTier still
 * covers rewards paid before this shop's stamps existed.
 */
async function rewardReferrerIfEligible(
  { businessId, trigger, source = 'license.service' },
  deps = defaultDeps,
) {
  const business = await deps.Business.findById(businessId);
  if (!business || !business.referredByBusinessId) {
    return { rewarded: false };
  }

  // What the referrer's ledger may say about the referred shop: which shop
  // and what it did — never its Razorpay order or payment ids.
  const extraMeta = { trigger, source };
  const tiers = trigger === 'LICENSE_PURCHASED' ? ['INVITE', 'PURCHASE'] : ['INVITE'];
  let credits = 0;

  for (const tier of tiers) {
    if (!(await claimTier(businessId, tier, deps))) continue;
    try {
      if (await payTier(business, businessId, tier, TIER_CREDITS[tier], extraMeta, deps)) {
        credits += TIER_CREDITS[tier];
      }
    } catch (error) {
      await releaseTier(businessId, tier, deps);
      throw error;
    }
  }

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
  resolveReferralCode,
  linkReferral,
  applyReferralCode,
  rewardReferrerIfEligible,
  getReferralOverview,
};

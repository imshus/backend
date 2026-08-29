const OrganizationSubscription = require('../models/organizationSubscription.model');
const billingConfigService = require('./billingConfig.service');

const TRIAL_DAYS = 10;
const TRIAL_CREDITS = 100;
const PURCHASE_AMOUNT = 12000;
const PURCHASE_BONUS_CREDITS = 1000;

function addDays(baseDate, days) {
  const cloned = new Date(baseDate);
  cloned.setUTCDate(cloned.getUTCDate() + days);
  return cloned;
}

function deriveStatus(subscription) {
  if (subscription.applicationPurchased) {
    return 'PURCHASED';
  }

  if (subscription.trialStatus === 'ACTIVE') {
    return 'FREE_TRIAL';
  }

  if (subscription.trialStatus === 'EXPIRED') {
    return 'EXPIRED';
  }

  return 'NO_SUBSCRIPTION';
}

async function ensureSubscription(businessId) {
  const cfg = await billingConfigService.getEffectiveConfig();
  let subscription = await OrganizationSubscription.findOne({ businessId });
  if (!subscription) {
    subscription = await OrganizationSubscription.create({
      businessId,
      trialStatus: 'NOT_STARTED',
      trialDays: cfg.trialDays,
      trialCredits: cfg.freeTrialCredits,
      applicationPurchased: false,
    });
  }
  return syncTrialStatus(subscription);
}

async function syncTrialStatus(subscription) {
  if (!subscription) {
    return subscription;
  }

  if (
    subscription.trialStatus === 'ACTIVE'
    && subscription.trialEndDate
    && new Date() > new Date(subscription.trialEndDate)
  ) {
    subscription.trialStatus = 'EXPIRED';
    await subscription.save();
    console.info('[TRIAL_EXPIRED]', {
      businessId: String(subscription.businessId),
      trialEndDate: subscription.trialEndDate,
      at: new Date().toISOString(),
    });
  }

  return subscription;
}

async function getSubscriptionOverview(businessId) {
  const subscription = await ensureSubscription(businessId);
  return {
    subscription,
    status: deriveStatus(subscription),
  };
}

function canScan(subscription) {
  return Boolean(subscription.applicationPurchased || subscription.trialStatus === 'ACTIVE');
}

async function startTrial(businessId, actorUserId) {
  const cfg = await billingConfigService.getEffectiveConfig();
  const subscription = await ensureSubscription(businessId);
  await syncTrialStatus(subscription);

  if (subscription.applicationPurchased) {
    return { subscription, trialStarted: false, reason: 'APPLICATION_ALREADY_PURCHASED' };
  }

  if (subscription.trialStatus === 'ACTIVE') {
    return { subscription, trialStarted: false, reason: 'TRIAL_ALREADY_ACTIVE' };
  }

  if (subscription.trialStatus === 'EXPIRED') {
    return { subscription, trialStarted: false, reason: 'TRIAL_ALREADY_EXPIRED' };
  }

  const now = new Date();
  const trialDays = Number(cfg.trialDays || TRIAL_DAYS);
  const trialCredits = Number(cfg.freeTrialCredits || TRIAL_CREDITS);
  subscription.trialStatus = 'ACTIVE';
  subscription.trialDays = trialDays;
  subscription.trialCredits = trialCredits;
  subscription.trialStartDate = now;
  subscription.trialEndDate = addDays(now, trialDays);
  await subscription.save();

  console.info('[TRIAL_STARTED]', {
    businessId: String(businessId),
    actorUserId: actorUserId || null,
    trialDays,
    trialCredits,
    trialStartDate: subscription.trialStartDate,
    trialEndDate: subscription.trialEndDate,
  });

  return { subscription, trialStarted: true, creditsToAdd: trialCredits };
}

async function markPurchased(businessId, actorUserId) {
  const cfg = await billingConfigService.getEffectiveConfig();
  const subscription = await ensureSubscription(businessId);
  await syncTrialStatus(subscription);

  if (subscription.applicationPurchased) {
    return { subscription, purchasedNow: false, reason: 'APPLICATION_ALREADY_PURCHASED' };
  }

  const purchaseAmount = Number(cfg.applicationPrice || PURCHASE_AMOUNT);
  const bonusCredits = Number(cfg.purchasedBonusCredits || PURCHASE_BONUS_CREDITS);
  subscription.applicationPurchased = true;
  subscription.purchaseAmount = purchaseAmount;
  subscription.purchaseDate = new Date();
  subscription.bonusCredits = bonusCredits;
  await subscription.save();

  console.info('[APPLICATION_PURCHASED]', {
    businessId: String(businessId),
    actorUserId: actorUserId || null,
    purchaseAmount,
    bonusCredits,
    purchaseDate: subscription.purchaseDate,
  });

  return { subscription, purchasedNow: true, creditsToAdd: bonusCredits };
}

module.exports = {
  TRIAL_DAYS,
  TRIAL_CREDITS,
  PURCHASE_AMOUNT,
  PURCHASE_BONUS_CREDITS,
  deriveStatus,
  canScan,
  ensureSubscription,
  syncTrialStatus,
  getSubscriptionOverview,
  startTrial,
  markPurchased,
};

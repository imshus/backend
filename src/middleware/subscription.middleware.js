const subscriptionService = require('../services/subscription.service');
const walletService = require('../services/wallet.service');

async function attachSubscriptionContext(req, res, next) {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      const err = new Error('UNAUTHORIZED');
      err.statusCode = 401;
      throw err;
    }

    const { subscription, status } = await subscriptionService.getSubscriptionOverview(businessId);
    const wallet = await walletService.ensureWallet(businessId);

    req.subscriptionContext = {
      businessId,
      subscription,
      status,
      wallet,
    };

    console.info('[SUBSCRIPTION_CHECK]', {
      businessId: String(businessId),
      status,
      trialStatus: subscription.trialStatus,
      applicationPurchased: subscription.applicationPurchased,
      creditBalance: wallet.creditBalance,
    });

    next();
  } catch (error) {
    next(error);
  }
}

function checkTrial(req, res, next) {
  const ctx = req.subscriptionContext;
  if (!ctx) {
    const err = new Error('SUBSCRIPTION_CONTEXT_MISSING');
    err.statusCode = 500;
    return next(err);
  }

  if (ctx.subscription.applicationPurchased || ctx.subscription.trialStatus === 'ACTIVE') {
    return next();
  }

  const err = new Error(ctx.subscription.trialStatus === 'EXPIRED' ? 'TRIAL_EXPIRED' : 'TRIAL_REQUIRED');
  err.statusCode = 403;
  return next(err);
}

function checkCredits(req, res, next) {
  const ctx = req.subscriptionContext;
  if (!ctx) {
    const err = new Error('SUBSCRIPTION_CONTEXT_MISSING');
    err.statusCode = 500;
    return next(err);
  }

  if (Number(ctx.wallet.creditBalance || 0) <= 0) {
    const err = new Error('NO_CREDITS_AVAILABLE');
    err.statusCode = 402;
    return next(err);
  }

  return next();
}

function checkScanPermission(req, res, next) {
  const ctx = req.subscriptionContext;
  if (!ctx) {
    const err = new Error('SUBSCRIPTION_CONTEXT_MISSING');
    err.statusCode = 500;
    return next(err);
  }

  if (!subscriptionService.canScan(ctx.subscription)) {
    const err = new Error(ctx.subscription.trialStatus === 'EXPIRED' ? 'TRIAL_EXPIRED' : 'TRIAL_REQUIRED');
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
  attachSubscriptionContext,
  checkTrial,
  checkCredits,
  checkScanPermission,
};

const OrganizationWallet = require('../models/organizationWallet.model');
const CreditTransaction = require('../models/creditTransaction.model');
const { nextScanStats } = require('./statistics.service');
const billingConfigService = require('./billingConfig.service');

const toTwo = (value) => Number(Number(value || 0).toFixed(2));

function applySession(query, dbSession) {
  return dbSession ? query.session(dbSession) : query;
}

async function ensureWallet(businessId, options = {}) {
  const dbSession = options.dbSession || null;
  let wallet = await applySession(OrganizationWallet.findOne({ businessId }), dbSession);
  if (!wallet) {
    const payload = {
        businessId,
        creditBalance: 0,
        lifetimeScans: 0,
        monthScans: 0,
        todayScans: 0,
        statsMonthKey: null,
        statsDayKey: null,
        lastScanCost: 0,
        lastScanAt: null,
      };

    try {
      if (dbSession) {
        [wallet] = await OrganizationWallet.create([payload], { session: dbSession });
      } else {
        wallet = await OrganizationWallet.create(payload);
      }
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }
      wallet = await applySession(OrganizationWallet.findOne({ businessId }), dbSession);
    }
  }
  return wallet;
}

async function logCreditTransaction({
  businessId,
  userId = null,
  actionByUserId = null,
  type,
  amount,
  balanceBefore,
  balanceAfter,
  note = '',
  metadata = {},
  dbSession = null,
}) {
  const payload = {
    businessId,
    userId,
    actionByUserId,
    type,
    amount: toTwo(amount),
    balanceBefore: toTwo(balanceBefore),
    balanceAfter: toTwo(balanceAfter),
    note,
    metadata,
  };

  if (dbSession) {
    const [created] = await CreditTransaction.create([payload], { session: dbSession });
    return created;
  }

  return CreditTransaction.create(payload);
}

async function addCredits({ businessId, amount, userId = null, actionByUserId = null, type, note = '', metadata = {} }) {
  const safeAmount = toTwo(amount);
  if (safeAmount <= 0) {
    throw new Error('INVALID_CREDIT_AMOUNT');
  }

  const wallet = await ensureWallet(businessId);
  const before = toTwo(wallet.creditBalance);
  const after = toTwo(before + safeAmount);

  wallet.creditBalance = after;
  await wallet.save();

  await logCreditTransaction({
    businessId,
    userId,
    actionByUserId,
    type,
    amount: safeAmount,
    balanceBefore: before,
    balanceAfter: after,
    note,
    metadata,
  });

  console.info('[CREDITS_ADDED]', {
    businessId: String(businessId),
    type,
    amount: safeAmount,
    balanceBefore: before,
    balanceAfter: after,
  });

  return wallet;
}

async function setCredits({ businessId, targetAmount, userId = null, actionByUserId = null, type, note = '', metadata = {} }) {
  const wallet = await ensureWallet(businessId);
  const before = toTwo(wallet.creditBalance);
  const after = toTwo(targetAmount);

  if (after < 0) {
    throw new Error('INVALID_CREDIT_AMOUNT');
  }

  wallet.creditBalance = after;
  await wallet.save();

  await logCreditTransaction({
    businessId,
    userId,
    actionByUserId,
    type,
    amount: toTwo(Math.abs(after - before)),
    balanceBefore: before,
    balanceAfter: after,
    note,
    metadata,
  });

  console.info('[CREDITS_SET]', {
    businessId: String(businessId),
    type,
    balanceBefore: before,
    balanceAfter: after,
  });

  return wallet;
}

async function removeCredits({ businessId, amount, userId = null, actionByUserId = null, type, note = '', metadata = {} }) {
  const safeAmount = toTwo(amount);
  if (safeAmount <= 0) {
    throw new Error('INVALID_CREDIT_AMOUNT');
  }

  const wallet = await ensureWallet(businessId);
  const before = toTwo(wallet.creditBalance);
  if (before < safeAmount) {
    throw new Error('INSUFFICIENT_CREDITS');
  }

  const after = toTwo(before - safeAmount);
  wallet.creditBalance = after;
  await wallet.save();

  await logCreditTransaction({
    businessId,
    userId,
    actionByUserId,
    type,
    amount: safeAmount,
    balanceBefore: before,
    balanceAfter: after,
    note,
    metadata,
  });

  console.info('[CREDITS_REMOVED]', {
    businessId: String(businessId),
    type,
    amount: safeAmount,
    balanceBefore: before,
    balanceAfter: after,
  });

  return wallet;
}

async function deductScanCharge({
  businessId,
  userId = null,
  actionByUserId = null,
  amount,
  note = '',
  metadata = {},
  dbSession = null,
  effectiveConfig = null,
}) {
  const safeAmount = toTwo(amount);
  if (safeAmount <= 0) {
    throw new Error('INVALID_SCAN_CHARGE');
  }

  const wallet = await ensureWallet(businessId, { dbSession });
  const before = toTwo(wallet.creditBalance);
  if (before < safeAmount) {
    throw new Error('INSUFFICIENT_CREDITS');
  }

  const after = toTwo(before - safeAmount);
  const stats = nextScanStats(wallet);

  wallet.creditBalance = after;
  wallet.todayScans = stats.todayScans;
  wallet.monthScans = stats.monthScans;
  wallet.lifetimeScans = stats.lifetimeScans;
  wallet.statsDayKey = stats.statsDayKey;
  wallet.statsMonthKey = stats.statsMonthKey;
  wallet.lastScanCost = safeAmount;
  wallet.lastScanAt = new Date();
  await wallet.save(dbSession ? { session: dbSession } : undefined);

  await logCreditTransaction({
    businessId,
    userId,
    actionByUserId,
    type: 'SCAN_DEDUCTION',
    amount: safeAmount,
    balanceBefore: before,
    balanceAfter: after,
    note,
    metadata,
    dbSession,
  });

  const cfg = effectiveConfig || await billingConfigService.getEffectiveConfig();
  const criticalThreshold = Number(cfg.criticalCreditThreshold || 10);
  const lowThreshold = Number(cfg.lowCreditThreshold || 20);

  if (after <= 0) {
    console.warn('[NO_CREDIT]', { businessId: String(businessId), balanceAfter: after });
  } else if (after <= criticalThreshold) {
    console.warn('[CRITICAL_CREDIT]', { businessId: String(businessId), balanceAfter: after });
  } else if (after <= lowThreshold) {
    console.warn('[LOW_CREDIT]', { businessId: String(businessId), balanceAfter: after });
  }

  console.info('[CREDITS_DEDUCTED]', {
    businessId: String(businessId),
    amount: safeAmount,
    balanceBefore: before,
    balanceAfter: after,
  });

  return {
    wallet,
    balanceBefore: before,
    balanceAfter: after,
  };
}

module.exports = {
  toTwo,
  ensureWallet,
  addCredits,
  removeCredits,
  setCredits,
  deductScanCharge,
};

const BillingConfig = require('../models/billingConfig.model');

const DEFAULT_BILLING_CONFIG = {
  scope: 'GLOBAL',
  erf: 97,
  inputTokenPricePerMillionUsd: 0.2,
  outputTokenPricePerMillionUsd: 1.2,
  kComp: 0.27,
  aComp: 0,
  applicationPrice: 12000,
  freeTrialCredits: 10,
  purchasedBonusCredits: 1000,
  trialDays: 7,
  lowCreditThreshold: 20,
  criticalCreditThreshold: 10,
  minScanBalance: 0.74,
};

/** The balance a new scan must be above, as the config gives it; 0.74 otherwise. */
const DEFAULT_MIN_SCAN_BALANCE = DEFAULT_BILLING_CONFIG.minScanBalance;
function minScanBalanceOf(config) {
  const value = config?.minScanBalance;
  const configured = value === null || value === '' ? NaN : Number(value);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MIN_SCAN_BALANCE;
}

async function ensureConfig() {
  let config = await BillingConfig.findOne({ scope: 'GLOBAL' });
  if (!config) {
    config = await BillingConfig.create(DEFAULT_BILLING_CONFIG);
    return config;
  }

  // Keep historic deployments aligned with current billing baseline.
  if (Number(config.aComp) === 0.15) {
    config.aComp = 0;
    await config.save();
  }

  // The free trial is seven days now. A deployment still holding the old
  // ten-day default moves with it; any other length is a number someone chose
  // in billing settings, so it stays. An admin who wants ten days again sets
  // it there rather than here.
  if (Number(config.trialDays) === 10) {
    config.trialDays = 7;
    await config.save();
  }

  return config;
}

const CONFIG_CACHE_TTL_MS = 45_000;
let configCache = { value: null, fetchedAt: 0 };

async function getEffectiveConfig() {
  if (configCache.value && Date.now() - configCache.fetchedAt < CONFIG_CACHE_TTL_MS) {
    return configCache.value;
  }

  const config = await ensureConfig();
  const effective = {
    ...DEFAULT_BILLING_CONFIG,
    ...config.toObject(),
  };
  configCache = { value: effective, fetchedAt: Date.now() };
  return effective;
}

async function updateConfig(updates = {}, updatedBy = null) {
  const safeUpdates = { ...updates };
  delete safeUpdates.scope;
  safeUpdates.updatedBy = updatedBy || null;

  const config = await BillingConfig.findOneAndUpdate(
    { scope: 'GLOBAL' },
    { $set: safeUpdates },
    { new: true, upsert: true }
  );

  const effective = {
    ...DEFAULT_BILLING_CONFIG,
    ...config.toObject(),
  };
  configCache = { value: effective, fetchedAt: Date.now() };
  return effective;
}

module.exports = {
  DEFAULT_BILLING_CONFIG,
  ensureConfig,
  getEffectiveConfig,
  updateConfig,
  minScanBalanceOf,
  DEFAULT_MIN_SCAN_BALANCE,
};

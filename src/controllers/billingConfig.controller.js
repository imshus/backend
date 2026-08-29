const { sendSuccess } = require('../utils/apiResponse');
const billingConfigService = require('../services/billingConfig.service');

function sanitizeConfig(config) {
  const {
    webhookSecret,
    updatedBy,
    __v,
    _id,
    scope,
    ...rest
  } = config || {};
  return rest;
}

async function getBillingConfig(req, res, next) {
  try {
    const cfg = await billingConfigService.getEffectiveConfig();
    sendSuccess(res, sanitizeConfig(cfg));
  } catch (error) {
    next(error);
  }
}

async function updateBillingConfig(req, res, next) {
  try {
    const updated = await billingConfigService.updateConfig(req.body || {}, req.user?.userId || null);
    sendSuccess(res, sanitizeConfig(updated));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getBillingConfig,
  updateBillingConfig,
};

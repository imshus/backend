const FormulaConfig = require('../models/formulaConfig.model');
const DashboardMetrics = require('../models/dashboardMetrics.model');

const DEFAULT_DASHBOARD_MATRIX_VALUES = {
  '24k_mcx': true,
  '24k_rtgs': true,
  '24k_cash': true,
  '22k_rtgs': true,
  '22k_cash': true,
  '20k_rtgs': true,
  '20k_cash': true,
  '18k_rtgs': true,
  '18k_cash': true,
  '14k_rtgs': true,
  '14k_cash': true,
  '9k_rtgs': true,
  '9k_cash': true,
};

const normalizeDashboardMatrices = (values = {}) => ({
  ...DEFAULT_DASHBOARD_MATRIX_VALUES,
  ...Object.fromEntries(
    Object.entries(values).filter(([key]) => Object.prototype.hasOwnProperty.call(DEFAULT_DASHBOARD_MATRIX_VALUES, key))
  ),
});

const getFormulaConfig = async (req, res) => {
  try {
    const businessId = req.user.businessId;
    let config = await FormulaConfig.findOne({ businessId });

    if (!config) {
      config = {
        activeFormula: 'F1',
        formula2Rules: ['14K']
      };
    }

    res.status(200).json({ success: true, data: config });
  } catch (error) {
    console.error('Get Formula Config Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const updateFormulaConfig = async (req, res) => {
  try {
    const { activeFormula, formula2Rules } = req.body;
    const businessId = req.user.businessId;

    const updateData = {};
    if (activeFormula) {
      if (!['F1', 'F2'].includes(activeFormula)) {
        return res.status(400).json({ success: false, message: 'Invalid activeFormula value' });
      }
      updateData.activeFormula = activeFormula;
    }
    
    if (formula2Rules && Array.isArray(formula2Rules)) {
      updateData.formula2Rules = formula2Rules;
    }

    const config = await FormulaConfig.findOneAndUpdate(
      { businessId },
      { $set: updateData },
      { new: true, upsert: true }
    );

    res.status(200).json({ success: true, data: config });
  } catch (error) {
    console.error('Update Formula Config Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};


const getDashboardMatrices = async (req, res) => {
  try {
    const businessId = req.user.businessId;
    let metrics = await DashboardMetrics.findOne({ businessId });

    if (!metrics) {
      metrics = { metricsData: DEFAULT_DASHBOARD_MATRIX_VALUES };
    }

    res.status(200).json({ success: true, data: normalizeDashboardMatrices(metrics.metricsData || {}) });
  } catch (error) {
    console.error('Get Dashboard Matrices Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const updateDashboardMatrices = async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { values } = req.body;
    const normalizedValues = normalizeDashboardMatrices(values || {});

    const metrics = await DashboardMetrics.findOneAndUpdate(
      { businessId },
      { $set: { metricsData: normalizedValues } },
      { new: true, upsert: true }
    );

    res.status(200).json({ success: true, data: normalizeDashboardMatrices(metrics.metricsData || {}) });
  } catch (error) {
    console.error('Update Dashboard Matrices Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const getSupremeRates = async (req, res) => {
  try {
    const redisService = require('../services/redis.service');
    const SupremeChange = require('../models/supremeChange.model');

    const mcx = await redisService.getMcxCache() || 160000;
    const supreme = await SupremeChange.findOne().sort({ updatedAt: -1, createdAt: -1 });

    const rtgsChange = supreme && typeof supreme.rtgsChange === 'number' ? supreme.rtgsChange : 0;
    const cashChange = supreme && typeof supreme.cashChange === 'number' ? supreme.cashChange : 0;

    const supremeRtgs = mcx + rtgsChange;
    const supremeCash = mcx + cashChange;

    res.status(200).json({ success: true, data: { mcx, rtgsChange, cashChange, supremeRtgs, supremeCash } });
  } catch (error) {
    console.error('Get Supreme Rates Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const updateSupremeRates = async (req, res) => {
  try {
    const { rtgsChange, cashChange } = req.body;
    const userId = req.user.userId;
    const SupremeChange = require('../models/supremeChange.model');
    const redisService = require('../services/redis.service');

    const toNumber = (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
      return undefined;
    };

    const parsedRtgsChange = toNumber(rtgsChange);
    const parsedCashChange = toNumber(cashChange);

    const updateData = {};
    if (parsedRtgsChange !== undefined) updateData.rtgsChange = parsedRtgsChange;
    if (parsedCashChange !== undefined) updateData.cashChange = parsedCashChange;
    updateData.updatedBy = userId;

    const supreme = await SupremeChange.findOneAndUpdate(
      {},
      { $set: updateData },
      { new: true, upsert: true, sort: { updatedAt: -1, createdAt: -1 } }
    );

    const mcx = await redisService.getMcxCache() || 160000;
    const supremeRtgs = mcx + (supreme.rtgsChange || 0);
    const supremeCash = mcx + (supreme.cashChange || 0);

    await redisService.setSupremeCache({ mcx, supremeRtgs, supremeCash, rtgsChange: supreme.rtgsChange, cashChange: supreme.cashChange });

    // Invalidate per-business computed caches so owners see updated rates
    await redisService.invalidateAllGoldRatesCache();

    res.status(200).json({ success: true, data: { mcx, rtgsChange: supreme.rtgsChange, cashChange: supreme.cashChange, supremeRtgs, supremeCash } });
  } catch (error) {
    console.error('Update Supreme Rates Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

module.exports = {
  getFormulaConfig,
  updateFormulaConfig,
  getDashboardMatrices,
  updateDashboardMatrices
  ,getSupremeRates, updateSupremeRates
};

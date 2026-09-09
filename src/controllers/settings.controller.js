const FormulaConfig = require('../models/formulaConfig.model');
const DashboardMetrics = require('../models/dashboardMetrics.model');
const Business = require('../models/business.model');
const BusinessUser = require('../models/businessUser.model');
const einvoiceService = require('../services/einvoice.service');
const { settingsScope, findScopedSetting, upsertScopedSetting } = require('../services/userScope.service');

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
  // Bhaw rate source: true = JMD Patil live feed, false = Mega Bullion (supreme changes).
  'bhaw_source_jmd': false,
};

const normalizeDashboardMatrices = (values = {}) => ({
  ...DEFAULT_DASHBOARD_MATRIX_VALUES,
  ...Object.fromEntries(
    Object.entries(values).filter(([key]) => Object.prototype.hasOwnProperty.call(DEFAULT_DASHBOARD_MATRIX_VALUES, key))
  ),
});

/**
 * GET /settings/business-profile
 *
 * The business identity as it stands in the database. The app captures these
 * at login, so without this a rename — or a GST record repaired after signup —
 * would keep showing the stale copy until the user signed in again.
 */
/**
 * GET /settings/einvoice
 *
 * The business's e-invoicing state for the profile screen. The password is
 * never returned — only whether one is saved.
 */
const getEInvoiceSettings = async (req, res) => {
  try {
    const business = await Business.findById(req.user.businessId)
      .select('eInvoiceEnabled eInvoiceMode eInvoiceUsername eInvoicePasswordEnc')
      .lean();
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }
    return res.status(200).json({
      success: true,
      data: {
        enabled: Boolean(business.eInvoiceEnabled),
        mode: business.eInvoiceMode === 'live' ? 'live' : 'test',
        username: business.eInvoiceUsername || '',
        hasPassword: Boolean(business.eInvoicePasswordEnc),
      },
    });
  } catch (error) {
    console.error('Get E-Invoice Settings Error:', error);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * POST /settings/einvoice
 *
 * The owner saves the IRP API user they created for their own GSTIN on
 * einvoice1.gst.gov.in. An omitted password keeps the stored one; sending
 * enabled=true requires credentials to exist by the end of the update.
 */
const updateEInvoiceSettings = async (req, res) => {
  try {
    const { enabled, username, password, mode } = req.body || {};
    const business = await Business.findById(req.user.businessId).select(
      'eInvoiceEnabled eInvoiceMode eInvoiceUsername eInvoicePasswordEnc',
    );
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }

    if (username !== undefined) business.eInvoiceUsername = String(username || '').trim();
    if (typeof password === 'string' && password.trim()) {
      try {
        business.eInvoicePasswordEnc = einvoiceService.encryptCredential(password.trim());
      } catch (encErr) {
        if (encErr.message === 'EINVOICE_CRED_KEY_MISSING') {
          return res.status(500).json({
            success: false,
            message: 'The server has no EINVOICE_CRED_KEY set, so credentials cannot be stored yet.',
          });
        }
        throw encErr;
      }
    }
    if (enabled !== undefined) {
      const wantsOn = Boolean(enabled);
      if (wantsOn && (!business.eInvoiceUsername || !business.eInvoicePasswordEnc)) {
        return res.status(400).json({
          success: false,
          message: 'Save the IRP username and password before switching e-invoicing on.',
        });
      }
      business.eInvoiceEnabled = wantsOn;
    }
    if (mode !== undefined) {
      if (mode !== 'live' && mode !== 'test') {
        return res.status(400).json({ success: false, message: 'Mode must be live or test.' });
      }
      // Live mode without credentials would register nothing and print
      // nothing — refuse it so the switch always means what it says.
      if (mode === 'live' && (!business.eInvoiceUsername || !business.eInvoicePasswordEnc)) {
        return res.status(400).json({
          success: false,
          message: 'Live mode needs the IRP username and password saved first.',
        });
      }
      business.eInvoiceMode = mode;
      if (mode === 'live') business.eInvoiceEnabled = true;
    }

    await business.save();
    return res.status(200).json({
      success: true,
      data: {
        enabled: Boolean(business.eInvoiceEnabled),
        mode: business.eInvoiceMode === 'live' ? 'live' : 'test',
        username: business.eInvoiceUsername || '',
        hasPassword: Boolean(business.eInvoicePasswordEnc),
      },
    });
  } catch (error) {
    console.error('Update E-Invoice Settings Error:', error);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const getBusinessProfile = async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const business = await Business.findById(businessId).lean();
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }

    // The signed-in user's own contact details, not the business owner's.
    const user = req.user.userId
      ? await BusinessUser.findById(req.user.userId).select('phone userId').lean()
      : null;

    return res.status(200).json({
      success: true,
      data: {
        businessId: business._id.toString(),
        businessName: business.tradeName || business.legalName || '',
        legalName: business.legalName || '',
        gstNumber: business.gstNumber || '',
        businessType: business.companyType || business.businessType || '',
        address: business.address || '',
        stateName: business.stateName || '',
        pincode: business.pincode || '',
        phone: user?.phone || '',
        loginId: user?.userId || '',
        // Printed on the invoice footer.
        bankName: business.bankName || '',
        bankBranch: business.bankBranch || '',
        bankAccountNumber: business.bankAccountNumber || '',
        bankIfsc: business.bankIfsc || '',
        invoiceTerms: Array.isArray(business.invoiceTerms) ? business.invoiceTerms : [],
      },
    });
  } catch (error) {
    console.error('Get Business Profile Error:', error);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const getFormulaConfig = async (req, res) => {
  try {
    // The employee's own formula when they have saved one, else the shop's.
    let config = await findScopedSetting(FormulaConfig, settingsScope(req.user));

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

    // The owner writes the shop's formula; an employee writes their own.
    const config = await upsertScopedSetting(FormulaConfig, settingsScope(req.user), updateData);

    res.status(200).json({ success: true, data: config });
  } catch (error) {
    console.error('Update Formula Config Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};


const getDashboardMatrices = async (req, res) => {
  try {
    // The employee's own rows when they have saved them, else the shop's.
    let metrics = await findScopedSetting(DashboardMetrics, settingsScope(req.user));

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

    const metrics = await upsertScopedSetting(DashboardMetrics, settingsScope(req.user), {
      metricsData: normalizedValues,
    });

    // The bhaw source feeds the cached gold-rate computation, for every
    // account of this business.
    const redisService = require('../services/redis.service');
    await redisService.invalidateGoldRatesCache(businessId.toString());

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
  getBusinessProfile,
  getEInvoiceSettings,
  updateEInvoiceSettings,
  getFormulaConfig,
  updateFormulaConfig,
  getDashboardMatrices,
  updateDashboardMatrices
  ,getSupremeRates, updateSupremeRates
};

const FormulaConfig = require('../models/formulaConfig.model');
const DashboardMetrics = require('../models/dashboardMetrics.model');
const BullionSource = require('../models/bullionSource.model');
const Business = require('../models/business.model');
const BusinessUser = require('../models/businessUser.model');
const einvoiceService = require('../services/einvoice.service');
const { settingsScope, findScopedSetting, upsertScopedSetting } = require('../services/userScope.service');

// A shop that has saved nothing shows the 24K price alone; the lighter
// karats wait in the Choose Karat menu until they are ticked.
const DEFAULT_DASHBOARD_MATRIX_VALUES = {
  '24k_mcx': true,
  '24k_rtgs': true,
  '24k_cash': true,
  '22k_rtgs': false,
  '22k_cash': false,
  '20k_rtgs': false,
  '20k_cash': false,
  '18k_rtgs': false,
  '18k_cash': false,
  '14k_rtgs': false,
  '14k_cash': false,
  '9k_rtgs': false,
  '9k_cash': false,
  // Bhaw rate source: true = JMD Patil live feed, false = Mega Bullion (supreme changes).
  'bhaw_source_jmd': false,
};

// The three 24K rates are the shop's headline price and what Home falls back
// to: a record with no rate selected at all leaves the dashboard blank, which
// is how an abandoned or half-written record reads rather than a choice, so
// these come back on. Any record with something selected is left exactly as
// it is — 24K can be switched off like any other rate.
const OPENING_MATRIX_KEYS = ['24k_mcx', '24k_rtgs', '24k_cash'];

const isRateKey = (key) => key !== 'bhaw_source_jmd';

const normalizeDashboardMatrices = (values = {}) => {
  const merged = {
    ...DEFAULT_DASHBOARD_MATRIX_VALUES,
    ...Object.fromEntries(
      Object.entries(values).filter(([key]) => Object.prototype.hasOwnProperty.call(DEFAULT_DASHBOARD_MATRIX_VALUES, key))
    ),
  };

  const anyRateOn = Object.keys(merged).some((key) => isRateKey(key) && merged[key]);
  if (!anyRateOn) {
    for (const key of OPENING_MATRIX_KEYS) merged[key] = true;
  }
  return merged;
};

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
      ? await BusinessUser.findById(req.user.userId).select('phone userId fullName').lean()
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
        // The account holder's own name, as given at signup.
        fullName: user?.fullName || '',
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

// The two houses on the live bhaw feed. A shop may add more; those follow no
// vendor, so their rate is the shop's own RTGS and Cash changes.
const BUILT_IN_BULLION = [
  { key: 'jmd_patil', label: 'JMD Patil' },
  { key: 'mega_bullion', label: 'Mega Bullion' },
];
const MAX_CUSTOM_BULLION = 10;
const BULLION_NAME_MAX = 40;

const cleanBullionName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, BULLION_NAME_MAX);

/** The names a shop added: trimmed, de-duplicated, and never a built-in. */
const cleanCustomNames = (values) => {
  const out = [];
  const seen = new Set(BUILT_IN_BULLION.flatMap((house) => [house.key, house.label.toLowerCase()]));
  for (const value of Array.isArray(values) ? values : []) {
    const name = cleanBullionName(value);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_CUSTOM_BULLION) break;
  }
  return out;
};

/**
 * GET /settings/bullion — the houses this account can choose from and the one
 * it follows. An account that has never chosen follows the record the older
 * boolean left behind, so nothing changes under anyone.
 */
const getBullionSources = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    const [setting, metrics] = await Promise.all([
      findScopedSetting(BullionSource, scope),
      findScopedSetting(DashboardMetrics, scope),
    ]);

    const customNames = cleanCustomNames(setting?.customNames);
    const fallback = metrics?.metricsData?.bhaw_source_jmd ? 'jmd_patil' : 'mega_bullion';
    const stored = cleanBullionName(setting?.selected);
    const known = [...BUILT_IN_BULLION.map((house) => house.key), ...customNames];
    const selected = stored && known.includes(stored) ? stored : fallback;

    return res.status(200).json({
      success: true,
      data: { builtIn: BUILT_IN_BULLION, customNames, selected },
    });
  } catch (error) {
    console.error('Get Bullion Sources Error:', error);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/** POST /settings/bullion — the chosen house and the shop's own list. */
const updateBullionSources = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    const customNames = cleanCustomNames(req.body?.customNames);
    const requested = cleanBullionName(req.body?.selected);
    const known = [...BUILT_IN_BULLION.map((house) => house.key), ...customNames];

    if (requested && !known.includes(requested)) {
      return res
        .status(400)
        .json({ success: false, message: 'That bullion house is not one of yours' });
    }

    const selected = requested || BUILT_IN_BULLION[1].key;
    const setting = await upsertScopedSetting(BullionSource, scope, { selected, customNames });

    // The older boolean still drives anything that has not read this setting
    // yet, so it is kept in step: a house the shop added is not JMD Patil.
    const metrics = await findScopedSetting(DashboardMetrics, scope);
    await upsertScopedSetting(DashboardMetrics, scope, {
      metricsData: {
        ...(metrics?.metricsData || {}),
        bhaw_source_jmd: selected === 'jmd_patil',
      },
    });

    // The rate is cached per account; the choice changes what it should be.
    const redisService = require('../services/redis.service');
    await redisService.invalidateGoldRatesCache(scope.businessId.toString());

    return res.status(200).json({
      success: true,
      data: {
        builtIn: BUILT_IN_BULLION,
        customNames: cleanCustomNames(setting.customNames),
        selected: setting.selected,
      },
    });
  } catch (error) {
    console.error('Update Bullion Sources Error:', error);
    return res.status(500).json({ success: false, message: 'Server Error' });
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
  updateDashboardMatrices,
  getBullionSources,
  updateBullionSources
  ,getSupremeRates, updateSupremeRates
};

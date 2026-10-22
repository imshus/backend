const FormulaConfig = require('../models/formulaConfig.model');
const DashboardMetrics = require('../models/dashboardMetrics.model');
const BullionSource = require('../models/bullionSource.model');
const Business = require('../models/business.model');
const BusinessUser = require('../models/businessUser.model');
const einvoiceService = require('../services/einvoice.service');
const profileEditService = require('../services/profileEdit.service');
const {
  settingsScope,
  findScopedSetting,
  findScopedSettings,
  upsertScopedSetting,
} = require('../services/userScope.service');
const bhawService = require('../services/bhaw.service');
const {
  SOURCES,
  chosenHouse,
  findHouse,
  followedHouse,
  houseNameKey,
} = require('../services/bullionHouses');

// A shop that has saved nothing shows the MCX card alone; the 24K
// RTGS/Cash card and the lighter karats wait in settings until ticked.
const DEFAULT_DASHBOARD_MATRIX_VALUES = {
  '24k_mcx': true,
  '24k_rtgs': false,
  '24k_cash': false,
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
  // JMD Patil unless the shop has picked otherwise, at the shop's asking.
  // Always answered for the house followed (followsJmd), never taken from a save.
  'bhaw_source_jmd': true,
};

// MCX is the shop's headline price and what Home falls back to: a record
// with no rate selected at all leaves the dashboard blank, which is how an
// abandoned or half-written record reads rather than a choice, so it comes
// back on. Any record with something selected is left exactly as it is.
const OPENING_MATRIX_KEYS = ['24k_mcx'];

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
/** The session the profile-edit flow runs under: this user, this business. */
const editSession = (req) => ({ businessId: req.user.businessId, userId: req.user.userId });

/**
 * The four steps of changing a phone number or a GSTIN. Errors are passed to
 * the error handler by code (INVALID_MPIN, PHONE_ALREADY_REGISTERED and the
 * rest), which is what the app turns into a sentence.
 */
const startProfileEdit = async (req, res, next) => {
  try {
    const result = await profileEditService.startProfileEdit(editSession(req), req.body?.mpin);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return next(error);
  }
};

const sendProfilePhoneOtp = async (req, res, next) => {
  try {
    const result = await profileEditService.sendProfileChangeOtp(editSession(req), {
      editToken: req.body?.editToken,
      phone: req.body?.phone,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return next(error);
  }
};

const previewProfileGst = async (req, res, next) => {
  try {
    const result = await profileEditService.previewGstChange(editSession(req), {
      editToken: req.body?.editToken,
      gstNumber: req.body?.gstNumber,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return next(error);
  }
};

const updateBusinessProfile = async (req, res, next) => {
  try {
    const result = await profileEditService.applyProfileChanges(editSession(req), {
      editToken: req.body?.editToken,
      phone: req.body?.phone,
      otp: req.body?.otp,
      gstNumber: req.body?.gstNumber,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return next(error);
  }
};

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

    // The signed-in user's own contact details, not the business owner's. An
    // employee's token carries their Employee id; their own sign-in record is
    // found through its link back to it.
    const isEmployee = String(req.user.role || '').toUpperCase() === 'EMP';
    const user = !req.user.userId
      ? null
      : isEmployee
        ? await BusinessUser.findOne({ employeeId: req.user.userId, role: 'EMP', businessId })
          .select('phone userId fullName')
          .lean()
        : await BusinessUser.findById(req.user.userId).select('phone userId fullName').lean();

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
        formula2Rules: ['14K'],
        salesInvoiceLayout: 'SEPARATE'
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
    const { activeFormula, formula2Rules, salesInvoiceLayout } = req.body;
    const INVOICE_LAYOUTS = ['SEPARATE', 'GOLD_WITH_LABOUR', 'GOLD_WITH_WASTAGE'];

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

    if (salesInvoiceLayout) {
      if (!INVOICE_LAYOUTS.includes(salesInvoiceLayout)) {
        return res.status(400).json({ success: false, message: 'Invalid salesInvoiceLayout value' });
      }
      updateData.salesInvoiceLayout = salesInvoiceLayout;
    }

    // The owner writes the shop's formula; an employee writes their own.
    const config = await upsertScopedSetting(FormulaConfig, settingsScope(req.user), updateData);

    res.status(200).json({ success: true, data: config });
  } catch (error) {
    console.error('Update Formula Config Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};


/**
 * The older boolean (bhaw_source_jmd), answered for the house this account
 * follows: true while that is JMD Patil. Builds before 19 Oct 2026 pick
 * their house from it when they remember none, so a stored false — the
 * 29 Aug-21 Sep default, saved with the Home tiles — must not reach them as
 * Mega Bullion. Read off the known houses with no call to the feed: all it
 * says is JMD Patil or not.
 */
const followsJmd = async (scope) =>
  followedHouse(null, await findScopedSettings(BullionSource, scope)).key === SOURCES.JMD_PATIL;

const getDashboardMatrices = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    // The employee's own rows when they have saved them, else the shop's.
    const [metrics, jmd] = await Promise.all([
      findScopedSetting(DashboardMetrics, scope),
      followsJmd(scope),
    ]);

    res.status(200).json({
      success: true,
      data: { ...normalizeDashboardMatrices(metrics?.metricsData || {}), bhaw_source_jmd: jmd },
    });
  } catch (error) {
    console.error('Get Dashboard Matrices Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const updateDashboardMatrices = async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const scope = settingsScope(req.user);
    const { values } = req.body;
    // The house is chosen on Choose a Bullion only. A tile save carries the
    // boolean as the phone last had it — the old default false, from builds
    // of 29 Aug-21 Sep — so it is stored for the house followed instead.
    const normalizedValues = {
      ...normalizeDashboardMatrices(values || {}),
      bhaw_source_jmd: await followsJmd(scope),
    };

    const metrics = await upsertScopedSetting(DashboardMetrics, scope, {
      metricsData: normalizedValues,
    });

    // Any Dashboard Settings save drops this business's cached gold rates.
    const redisService = require('../services/redis.service');
    await redisService.invalidateGoldRatesCache(businessId.toString());

    res.status(200).json({ success: true, data: normalizeDashboardMatrices(metrics.metricsData || {}) });
  } catch (error) {
    console.error('Update Dashboard Matrices Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// The houses a shop can follow are the houses on the 3-minute feed — every
// one of them, by the feed's own key and name (bhawService.followableHouses),
// so a house the feed adds can be followed the day it appears. A name a shop
// adds is kept as a request for that house's rates; it is not a choice, so
// it never changes what Home costs, until that house is on the feed.
// The choice is read through followedHouse, the same reading the rate
// calculation prices on: two lists once drifted, and a shop's choice was
// silently priced on another house.
const MAX_CUSTOM_BULLION = 10;
const BULLION_NAME_MAX = 40;

const cleanBullionName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, BULLION_NAME_MAX);

/**
 * The names a shop added: trimmed, de-duplicated (case and spaces aside),
 * and never a house on the list — a requested house that is now on the feed
 * is that house, to be picked, not a request still waiting.
 */
const cleanCustomNames = (values, houses) => {
  const out = [];
  const seen = new Set(houses.flatMap((house) => [house.key, houseNameKey(house.label)]));
  for (const value of Array.isArray(values) ? values : []) {
    const name = cleanBullionName(value);
    const key = houseNameKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_CUSTOM_BULLION) break;
  }
  return out;
};

/** The list the app is sent: the feed's houses, the followed one always among them. */
const withHouse = (houses, house) => (
  houses.some((entry) => entry.key === house.key) ? houses : [...houses, house]
);

/**
 * GET /settings/bullion — the houses this account can follow (the feed's),
 * the one it follows, and the names it has asked us to add. An account that
 * has never chosen follows JMD Patil; an employee who has not chosen follows
 * the shop's choice.
 */
const getBullionSources = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    const [settings, board] = await Promise.all([
      findScopedSettings(BullionSource, scope),
      bhawService.followableHouses(),
    ]);

    const followed = followedHouse(board, settings);
    const builtIn = withHouse(board.houses, followed);

    return res.status(200).json({
      success: true,
      data: {
        builtIn,
        // The nearest record's names: the employee's own, else the shop's.
        requestedNames: cleanCustomNames(settings[0]?.customNames, builtIn),
        selected: followed.key,
      },
    });
  } catch (error) {
    console.error('Get Bullion Sources Error:', error);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * POST /settings/bullion — the house to follow, and any names the shop has
 * asked us to add. Any house on the feed can be followed, sent by its key (or
 * its feed name); the house the account already follows is never refused,
 * so a feed that is down for a moment does not stop a shop saving. A
 * requested name is recorded and answered later, so it cannot move a shop's
 * price today. Nothing sent as `selected` keeps the house followed — and
 * records no house when none was chosen, so the default never turns into a
 * choice — and nothing sent as `requestedNames` keeps the names already
 * asked for. A house the board in hand does not list is looked for on both
 * feeds once more (bhawService.findHouseOnFeed) before it is refused.
 */
const updateBullionSources = async (req, res) => {
  try {
    const scope = settingsScope(req.user);
    const [board, settings] = await Promise.all([
      bhawService.followableHouses(),
      findScopedSettings(BullionSource, scope),
    ]);
    // The record this save writes (the employee's own, the shop's for the
    // owner) and the nearest one, whose names stand when none are sent.
    const own = settings.find((setting) => String(setting.userId ?? '') === String(scope.userId ?? ''));
    const current = settings[0];
    const following = followedHouse(board, settings);
    const sent = req.body?.selected;
    // A house is sent as its key: anything but a string names no house.
    const requested = typeof sent === 'string' ? cleanBullionName(sent) : sent == null ? '' : null;
    // The phone lists the houses on the live stream, which carries a house the
    // tracker has just added up to 3 minutes before the board in hand does:
    // before refusing one, both feeds are looked at once more (bounded).
    const chosen = requested === null
      ? null
      : requested
        ? findHouse(board.houses, requested)
          || findHouse([following], requested)
          || await bhawService.findHouseOnFeed(requested)
        : following;

    if (!chosen) {
      return res
        .status(400)
        .json({ success: false, message: 'Pick one of the bullion houses on the feed' });
    }

    const builtIn = withHouse(board.houses, chosen);
    // No names sent (a house picked before the list had loaded on the phone)
    // keeps the names already asked for: [] would have wiped them.
    const sentNames = req.body?.requestedNames ?? req.body?.customNames;
    const customNames = cleanCustomNames(sentNames == null ? current?.customNames : sentNames, builtIn);
    // A house sent is chosen. None sent keeps this record's own choice, or
    // none: writing the house it merely follows (JMD Patil by default, or the
    // shop's) would make that a choice — it once stored Mega Bullion, the
    // older boolean's default, for shops that had only added a name.
    const selected = requested ? chosen.key : chosenHouse(board, own)?.key || '';
    await upsertScopedSetting(BullionSource, scope, { selected, customNames });
    if (customNames.length) {
      // What the shop is waiting for, in the log the team reads.
      console.info('[BULLION_REQUESTED]', {
        businessId: String(scope.businessId),
        userId: scope.userId ? String(scope.userId) : null,
        names: customNames,
      });
    }

    // The older boolean is kept in step with the house now followed (`chosen`:
    // the one picked, else the one already followed): any house but JMD
    // Patil reads false.
    const metrics = await findScopedSetting(DashboardMetrics, scope);
    await upsertScopedSetting(DashboardMetrics, scope, {
      metricsData: {
        ...(metrics?.metricsData || {}),
        bhaw_source_jmd: chosen.key === SOURCES.JMD_PATIL,
      },
    });

    // The rate is cached per account; the choice changes what it should be.
    const redisService = require('../services/redis.service');
    await redisService.invalidateGoldRatesCache(scope.businessId.toString());

    return res.status(200).json({
      success: true,
      data: {
        builtIn,
        requestedNames: cleanCustomNames(customNames, builtIn),
        selected: chosen.key,
      },
    });
  } catch (error) {
    console.error('Update Bullion Sources Error:', error);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * The supreme rates as they stand: the stored MCX (24K per 10 g) and that
 * plus each change. With no stored MCX there is no MCX to show and no rate
 * built on it: mcx, supremeRtgs and supremeCash are null and
 * ratesUnavailable is true. It used to show Rs 1,60,000 as if it were live.
 */
const supremeFigures = (mcx, rtgsChange, cashChange) => (mcx === null
  ? { mcx: null, rtgsChange, cashChange, supremeRtgs: null, supremeCash: null, ratesUnavailable: true }
  : { mcx, rtgsChange, cashChange, supremeRtgs: mcx + rtgsChange, supremeCash: mcx + cashChange });

const getSupremeRates = async (req, res) => {
  try {
    const mcxService = require('../services/mcx.service');
    const SupremeChange = require('../models/supremeChange.model');

    const mcx = await mcxService.getLiveMcxRate24K();
    const supreme = await SupremeChange.findOne().sort({ updatedAt: -1, createdAt: -1 });

    const rtgsChange = supreme && typeof supreme.rtgsChange === 'number' ? supreme.rtgsChange : 0;
    const cashChange = supreme && typeof supreme.cashChange === 'number' ? supreme.cashChange : 0;

    res.status(200).json({ success: true, data: supremeFigures(mcx, rtgsChange, cashChange) });
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

    const mcxService = require('../services/mcx.service');
    const mcx = await mcxService.getLiveMcxRate24K();
    const figures = supremeFigures(mcx, supreme.rtgsChange || 0, supreme.cashChange || 0);

    // The changes are what pricing reads from this cache, so they are cached
    // either way; the MCX and the rates built on it only when there is one.
    await redisService.setSupremeCache(mcx === null
      ? { rtgsChange: supreme.rtgsChange, cashChange: supreme.cashChange }
      : {
        mcx,
        supremeRtgs: figures.supremeRtgs,
        supremeCash: figures.supremeCash,
        rtgsChange: supreme.rtgsChange,
        cashChange: supreme.cashChange,
      });

    // Invalidate per-business computed caches so owners see updated rates
    await redisService.invalidateAllGoldRatesCache();

    res.status(200).json({
      success: true,
      data: { ...figures, rtgsChange: supreme.rtgsChange, cashChange: supreme.cashChange },
    });
  } catch (error) {
    console.error('Update Supreme Rates Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

module.exports = {
  getBusinessProfile,
  startProfileEdit,
  sendProfilePhoneOtp,
  previewProfileGst,
  updateBusinessProfile,
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

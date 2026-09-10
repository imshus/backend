const mongoose = require('mongoose');
const GoldRate = require('../models/goldRate.model');
const DiamondRate = require('../models/diamondRate.model');
const ColorstoneRate = require('../models/colorstoneRate.model');
const LabourRate = require('../models/labourRate.model');
const GoldTaxSetting = require('../models/goldTaxSetting.model');
const { getLiveGoldRates } = require('../services/rateCalculation.service');
const { findDiamondRateMatch } = require('../services/diamondRateLookup.service');
const redisService = require('../services/redis.service');
const {
  settingsScope,
  scopeCacheId,
  findScopedSetting,
  upsertScopedSetting,
  findScopedRows,
  materializeOwnRows,
  resolveScopedRowById,
} = require('../services/userScope.service');

const DIAMOND_KEY_FIELDS = ['color', 'clarity', 'shape', 'packetCode'];
const COLORSTONE_KEY_FIELDS = ['color', 'clarity'];
const {
  addPromptCustomization,
  getPromptCustomizations,
  buildCustomPromptSnippet,
} = require('../services/promptCustomization.service');

const DEFAULT_DIAMOND_COLORS = new Set([
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'EF',
  'FG',
  'GH',
  'HI',
  'IJ',
]);
const DEFAULT_DIAMOND_CLARITIES = new Set([
  'FL',
  'IF',
  'VVS',
  'VVS1',
  'VVS2',
  'VS',
  'VS1',
  'VS2',
  'SI',
  'SI1',
  'SI2',
  'SS',
  'I1',
  'I2',
  'I3',
]);
const DEFAULT_DIAMOND_SHAPES = new Set([
  'RD',
  'MQ',
  'PR',
  'EM',
  'BG',
  'PC',
  'OV',
  'CU',
  'HT',
  'RA',
  'AS',
  'TR',
]);
const DEFAULT_COLORSTONE_COLORS = new Set(['RED', 'BLUE', 'GREEN', 'PINK']);
const DEFAULT_COLORSTONE_CLARITIES = new Set(['SI', 'VS', 'VS1', 'VVS', 'VVS1']);

const CARAT_ALIASES = {
  '22KT': '22Kt',
  '22 K': '22Kt',
  '22 KT': '22Kt',
  '20KT': '20Kt',
  '20 K': '20Kt',
  '20 KT': '20Kt',
  '18KT': '18Kt',
  '18 K': '18Kt',
  '18 KT': '18Kt',
  '14KT': '14Kt',
  '14 K': '14Kt',
  '14 KT': '14Kt',
  '9KT': '9Kt',
  '9 K': '9Kt',
  '9 KT': '9Kt'
};

const normalizeCarat = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return raw;

  if (['22Kt', '20Kt', '18Kt', '14Kt', '9Kt'].includes(raw)) {
    return raw;
  }

  const upper = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  return CARAT_ALIASES[upper] || raw;
};

// === GOLD RATES ===

const updateGoldRate = async (req, res) => {
  try {
    const { carat, purity, increaseByAmount, increaseByType } = req.body;
    const businessId = req.user.businessId;
    const scope = settingsScope(req.user);
    const normalizedCarat = normalizeCarat(carat);

    if (!normalizedCarat || purity == null) {
      return res.status(400).json({ success: false, message: 'Carat and purity are required' });
    }

    // An employee's first gold edit copies the shop's table for them.
    await materializeOwnRows(GoldRate, scope);
    const goldRate = await GoldRate.findOneAndUpdate(
      { businessId, userId: scope.userId ?? null, carat: normalizedCarat },
      {
        $set: {
          carat: normalizedCarat,
          purity,
          increaseByAmount: increaseByAmount || 0,
          increaseByType: increaseByType || 'FLAT',
        },
      },
      { new: true, upsert: true }
    );

    // Invalidate Cache since configuration changed
    await redisService.invalidateGoldRatesCache(businessId.toString());

    // Return computed shape (with finalRate/mcxRate/cashRate/rtgsRate) expected by frontend
    const live = await getLiveGoldRates(businessId, settingsScope(req.user));
    const updatedComputed = Array.isArray(live?.karatRates)
      ? live.karatRates.find((row) => row.carat === normalizedCarat)
      : null;

    res.status(200).json({ success: true, data: updatedComputed || goldRate });
  } catch (error) {
    console.error('Update Gold Rate Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server Error' });
  }
};

const updateGoldRateVisibility = async (req, res) => {
  try {
    const { carat, id, hidden } = req.body;
    const businessId = req.user.businessId;
    const scope = settingsScope(req.user);

    if (hidden == null) {
      return res.status(400).json({ success: false, message: 'Hidden flag is required' });
    }

    await materializeOwnRows(GoldRate, scope);

    let target = null;
    if (id) {
      // The id the client shows may still be a shop row the employee was
      // inheriting; resolve it into their own copy by carat.
      target = await resolveScopedRowById(GoldRate, scope, id, ['carat']);
    } else if (carat) {
      const normalizedCarat = normalizeCarat(carat);
      if (!normalizedCarat) {
        return res.status(400).json({ success: false, message: 'Valid carat is required' });
      }
      target = await GoldRate.findOne({ businessId, userId: scope.userId ?? null, carat: normalizedCarat });
    } else {
      return res.status(400).json({ success: false, message: 'Carat or id is required' });
    }

    if (!target) {
      return res.status(404).json({ success: false, message: 'Gold rate not found' });
    }

    target.isHidden = !!hidden;
    await target.save();
    const updated = target;

    await redisService.invalidateGoldRatesCache(businessId.toString());

    const live = await getLiveGoldRates(businessId, settingsScope(req.user));
    const updatedComputed = Array.isArray(live?.karatRates)
      ? live.karatRates.find((row) => row.carat === updated.carat)
      : null;

    return res.status(200).json({ success: true, data: updatedComputed || updated });
  } catch (error) {
    console.error('Update Gold Rate Visibility Error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Server Error' });
  }
};

const getGoldRates = async (req, res) => {
  try {
    const businessId = req.user.businessId;
    // Uses the "Supreme Truth Engine" which orchestrates MongoDB + Redis + Live Math,
    // against this account's own rate settings when it has saved any.
    const data = await getLiveGoldRates(businessId, settingsScope(req.user));
    
    // Keep all fields inside a single data envelope so frontend unwrapApiData preserves them.
    res.status(200).json({
      success: true,
      data: {
        mcxLiveRate: data.mcxLiveRate,
        supremeChanges: data.supremeChanges,
        taxSettings: data.taxSettings,
        rates: data.karatRates,
      },
    });
  } catch (error) {
    console.error('Get Gold Rates Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// === GOLD TAX SETTINGS ===

const getGoldTaxSettings = async (req, res) => {
  try {
    // The employee's own adjustments when they have saved any, else the shop's.
    let taxSettings = await findScopedSetting(GoldTaxSetting, settingsScope(req.user));
    if (!taxSettings) {
      taxSettings = {
        mcxChange: { operation: '+', amount: 0 },
        rtgsChangeBy: 0,
        cashChangeBy: 0,
        scannerCalculationUse: 'rtgs'
      };
    }
    res.status(200).json({ success: true, data: taxSettings });
  } catch (error) {
    console.error('Get Gold Tax Settings Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const updateGoldTaxSettings = async (req, res) => {
  try {
    const { rtgsChangeBy, cashChangeBy, scannerCalculationUse, mcxChange } = req.body;
    const businessId = req.user.businessId;

    const updateData = {};
    if (mcxChange && typeof mcxChange === 'object') {
      const operation = mcxChange.operation === '-' ? '-' : '+';
      const amount = typeof mcxChange.amount === 'number' ? mcxChange.amount : Number(mcxChange.amount || 0);
      updateData.mcxChange = {
        operation,
        amount: Number.isFinite(amount) && amount > 0 ? amount : 0
      };
    }
    if (rtgsChangeBy !== undefined) updateData.rtgsChangeBy = rtgsChangeBy;
    if (cashChangeBy !== undefined) updateData.cashChangeBy = cashChangeBy;
    if (scannerCalculationUse) updateData.scannerCalculationUse = scannerCalculationUse === 'cash' ? 'cash' : 'rtgs';

    // The owner writes the shop's adjustments; an employee writes their own.
    const taxSettings = await upsertScopedSetting(GoldTaxSetting, settingsScope(req.user), updateData);

    // Invalidate Cache since base rate logic changed, for every account of the business
    await redisService.invalidateGoldRatesCache(businessId.toString());

    res.status(200).json({ success: true, data: taxSettings });
  } catch (error) {
    console.error('Update Gold Tax Settings Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// === DIAMOND RATES ===
const addOrUpdateDiamondRate = async (req, res) => {
  try {
    const { id, color, clarity, rate, shape, packetCode } = req.body;
    const businessId = req.user.businessId;
    const scope = settingsScope(req.user);

    const trimmedColor = typeof color === 'string' ? color.trim() : '';
    const trimmedClarity = typeof clarity === 'string' ? clarity.trim() : '';
    const rawShape = typeof shape === 'string' ? shape.trim() : '';
    const normalizedPacketCode = typeof packetCode === 'string' ? packetCode.trim().toUpperCase() : '';
    const normalizedShapeInput = rawShape && rawShape.toLowerCase() !== 'none' && rawShape !== '0'
      ? rawShape
      : '';
    const normalizedShape = normalizedShapeInput;

    if (!normalizedPacketCode && !trimmedColor && !trimmedClarity && !normalizedShapeInput) {
      return res
        .status(400)
        .json({ success: false, message: 'At least one of packet code, shape, color or clarity is required' });
    }

    if (rate == null) {
      return res
        .status(400)
        .json({ success: false, message: 'Rate is required' });
    }

    const normalizedColor = trimmedColor || '';
    const normalizedClarity = trimmedClarity || '';

    let promptUpdated = false;

    const colorKey = normalizedColor.toUpperCase();
    const clarityKey = normalizedClarity.toUpperCase();
    const shapeKey = normalizedShape.toUpperCase();
    // Filed under the caller, the way their rate rows are.
    const promptId = scopeCacheId(scope);

    if (normalizedColor && !DEFAULT_DIAMOND_COLORS.has(colorKey)) {
      const { added } = await addPromptCustomization('diamond', 'color', normalizedColor, promptId);
      promptUpdated = promptUpdated || added;
    }
    if (normalizedClarity && !DEFAULT_DIAMOND_CLARITIES.has(clarityKey)) {
      const { added } = await addPromptCustomization('diamond', 'clarity', normalizedClarity, promptId);
      promptUpdated = promptUpdated || added;
    }
    if (shapeKey && !DEFAULT_DIAMOND_SHAPES.has(shapeKey)) {
      const { added } = await addPromptCustomization('diamond', 'shape', normalizedShape, promptId);
      promptUpdated = promptUpdated || added;
    }

    if (promptUpdated) {
      const customizations = await getPromptCustomizations('diamond', promptId);
      const snippet = buildCustomPromptSnippet(customizations, 100, 'diamond');
      if (snippet) {
        console.log('[PROMPT] Custom diamond options section (100 words):');
        console.log(snippet);
      }
    }

    // An employee's first diamond edit copies the shop's table for them.
    await materializeOwnRows(DiamondRate, scope);

    if (id && mongoose.Types.ObjectId.isValid(id)) {
      // The id may still point at a shop row the employee was inheriting;
      // resolve it into the row in their own copy.
      const target = await resolveScopedRowById(DiamondRate, scope, id, DIAMOND_KEY_FIELDS);
      const updated = target
        ? await DiamondRate.findOneAndUpdate(
            { _id: target._id },
            {
              rate,
              shape: normalizedShape,
              color: normalizedColor,
              clarity: normalizedClarity,
              packetCode: normalizedPacketCode,
            },
            { new: true }
          )
        : null;

      if (!updated) {
        return res.status(404).json({ success: false, message: 'Diamond rate not found' });
      }

      if (normalizedPacketCode) {
        const packetCodes = await DiamondRate.find({ businessId, userId: scope.userId ?? null, packetCode: { $ne: '' } })
          .select('packetCode')
          .lean();
        const packetCustomization = {
          colors: [],
          clarities: [],
          shapes: [],
          packetCodes: packetCodes
            .map((item) => String(item.packetCode || '').trim())
            .filter(Boolean),
        };
        const snippet = buildCustomPromptSnippet(packetCustomization, 100, 'diamond');
        if (snippet) {
          console.log('[PROMPT] Custom packet codes section (100 words):');
          console.log(snippet);
        }
      }

      return res.status(200).json({ success: true, data: updated });
    }

    const baseQuery = normalizedPacketCode
      ? { businessId, userId: scope.userId ?? null, packetCode: normalizedPacketCode }
      : {
          businessId,
          userId: scope.userId ?? null,
          color: normalizedColor,
          clarity: normalizedClarity,
        };

    const shapeQuery = normalizedPacketCode
      ? {}
      : !normalizedShape
        ? { $or: [{ shape: 0 }, { shape: { $exists: false } }, { shape: null }, { shape: '' }] }
        : { shape: normalizedShape };

    const diamondRate = await DiamondRate.findOneAndUpdate(
      {
        ...baseQuery,
        ...shapeQuery,
      },
      {
        rate,
        shape: normalizedShape,
        color: normalizedColor,
        clarity: normalizedClarity,
        packetCode: normalizedPacketCode,
      },
      { new: true, upsert: true }
    );

    if (normalizedPacketCode) {
      const packetCodes = await DiamondRate.find({ businessId, userId: scope.userId ?? null, packetCode: { $ne: '' } })
        .select('packetCode')
        .lean();
      const packetCustomization = {
        colors: [],
        clarities: [],
        shapes: [],
        packetCodes: packetCodes
          .map((item) => String(item.packetCode || '').trim())
          .filter(Boolean),
      };
      const snippet = buildCustomPromptSnippet(packetCustomization, 100, 'diamond');
      if (snippet) {
        console.log('[PROMPT] Custom packet codes section (100 words):');
        console.log(snippet);
      }
    }

    res.status(200).json({ success: true, data: diamondRate });
  } catch (error) {
    if (error && error.code === 11000) {
      return res
        .status(409)
        .json({ success: false, message: 'Duplicate diamond rate entry' });
    }
    console.error('Add Diamond Rate Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const getDiamondRates = async (req, res) => {
  try {
    console.log('[RATE] GET /rates/diamond hit by user:', req.user?.businessId);
    // The employee's own table when they have one, else the shop's.
    const rates = await findScopedRows(DiamondRate, settingsScope(req.user));
    res.status(200).json({ success: true, data: rates });
  } catch (error) {
    console.error('Get Diamond Rates Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const lookupDiamondRate = async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { color, clarity, shape, packetCode } = req.body || {};

    const trimmedColor = typeof color === 'string' ? color.trim() : '';
    const trimmedClarity = typeof clarity === 'string' ? clarity.trim() : '';
    const rawShape = typeof shape === 'string' ? shape.trim() : '';
    const normalizedShape = rawShape && rawShape.toLowerCase() !== 'none' && rawShape !== '0'
      ? rawShape
      : '';
    const normalizedPacketCode = typeof packetCode === 'string' ? packetCode.trim().toUpperCase() : '';

    if (!normalizedPacketCode && !trimmedColor && !trimmedClarity && !normalizedShape) {
      return res
        .status(400)
        .json({ success: false, message: 'At least one of packet code, shape, color or clarity is required' });
    }

    const rows = (await findScopedRows(DiamondRate, settingsScope(req.user))).map((doc) =>
      typeof doc.toObject === 'function' ? doc.toObject() : doc,
    );
    const match = findDiamondRateMatch(rows, {
      color: trimmedColor,
      clarity: trimmedClarity,
      shape: normalizedShape,
      packetCode: normalizedPacketCode,
    });

    if (!match) {
      console.warn('[DIAMOND_RATE_LOOKUP_MISS]', {
        requested: { color: trimmedColor, clarity: trimmedClarity, shape: normalizedShape, packetCode: normalizedPacketCode },
        configuredSample: rows.slice(0, 10).map((row) => ({
          color: row.color, clarity: row.clarity, shape: row.shape, packetCode: row.packetCode,
        })),
        totalConfigured: rows.length,
      });
      return res.status(404).json({ success: false, message: 'Diamond rate not found' });
    }

    return res.status(200).json({ success: true, data: { rate: match.rate } });
  } catch (error) {
    console.error('Lookup Diamond Rate Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const deleteDiamondRate = async (req, res) => {
  try {
    const { id } = req.params;
    const scope = settingsScope(req.user);
    // An employee deleting from an inherited table first gets their own copy,
    // then the matching row of that copy is removed.
    await materializeOwnRows(DiamondRate, scope);
    const target = await resolveScopedRowById(DiamondRate, scope, id, DIAMOND_KEY_FIELDS);
    if (target) await DiamondRate.deleteOne({ _id: target._id });
    res.status(200).json({ success: true, message: 'Deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// === COLORSTONE RATES ===

const addOrUpdateColorstoneRate = async (req, res) => {
  try {
    const { color, clarity, rate } = req.body;
    const businessId = req.user.businessId;
    const scope = settingsScope(req.user);
    // Filed under the caller, the way their rate rows are.
    const promptId = scopeCacheId(scope);

    const trimmedColor = typeof color === 'string' ? color.trim() : '';
    const trimmedClarity = typeof clarity === 'string' ? clarity.trim() : '';

    if (!trimmedColor && !trimmedClarity) {
      return res
        .status(400)
        .json({ success: false, message: 'At least one of color or clarity is required' });
    }

    if (rate == null) {
      return res.status(400).json({ success: false, message: 'Rate is required' });
    }

    let promptUpdated = false;
    const colorKey = trimmedColor.toUpperCase();
    const clarityKey = trimmedClarity.toUpperCase();

    if (trimmedColor && !DEFAULT_COLORSTONE_COLORS.has(colorKey)) {
      const { added } = await addPromptCustomization('colorstone', 'color', trimmedColor, promptId);
      promptUpdated = promptUpdated || added;
    }
    if (trimmedClarity && !DEFAULT_COLORSTONE_CLARITIES.has(clarityKey)) {
      const { added } = await addPromptCustomization('colorstone', 'clarity', trimmedClarity, promptId);
      promptUpdated = promptUpdated || added;
    }

    // An employee's first colorstone edit copies the shop's table for them.
    await materializeOwnRows(ColorstoneRate, scope);
    const colorstoneRate = await ColorstoneRate.findOneAndUpdate(
      { businessId, userId: scope.userId ?? null, color: trimmedColor, clarity: trimmedClarity },
      { rate },
      { new: true, upsert: true }
    );

    if (promptUpdated) {
      const customizations = await getPromptCustomizations('colorstone', promptId);
      const snippet = buildCustomPromptSnippet(customizations, 100, 'colorstone');
      if (snippet) {
        console.log('[PROMPT] Custom colorstone options section (100 words):');
        console.log(snippet);
      }
    }

    res.status(200).json({ success: true, data: colorstoneRate });
  } catch (error) {
    console.error('Add Colorstone Rate Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const getColorstoneRates = async (req, res) => {
  try {
    // The employee's own table when they have one, else the shop's.
    const rates = await findScopedRows(ColorstoneRate, settingsScope(req.user));
    res.status(200).json({ success: true, data: rates });
  } catch (error) {
    console.error('Get Colorstone Rates Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const deleteColorstoneRate = async (req, res) => {
  try {
    const { id } = req.params;
    const scope = settingsScope(req.user);
    await materializeOwnRows(ColorstoneRate, scope);
    const target = await resolveScopedRowById(ColorstoneRate, scope, id, COLORSTONE_KEY_FIELDS);
    if (target) await ColorstoneRate.deleteOne({ _id: target._id });
    res.status(200).json({ success: true, message: 'Deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// === LABOUR RATES ===

const getLabourRate = async (req, res) => {
  try {
    // The employee's own charge when they have saved one, else the shop's.
    // A stored NONE row is an explicit "no labour charge" and reads as null.
    const labourRate = await findScopedSetting(LabourRate, settingsScope(req.user));
    res.status(200).json({ success: true, data: labourRate && labourRate.chargeType !== 'NONE' ? labourRate : null });
  } catch (error) {
    console.error('Get Labour Rate Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const upsertLabourRate = async (req, res) => {
  try {
    const { chargeType, value, rupeesUnit, weightBasis } = req.body;
    const businessId = req.user.businessId;
    const scope = settingsScope(req.user);
    const scopedQuery = { businessId, userId: scope.userId ?? null };

    if (!chargeType) {
      return res.status(400).json({
        success: false,
        message: 'chargeType is required',
      });
    }

    if (chargeType === 'NONE') {
      // Stored rather than deleted: an employee's deleted row would fall back
      // to the shop's charge, which is not what "no labour charge" means.
      await LabourRate.findOneAndUpdate(
        scopedQuery,
        { $set: { chargeType: 'NONE', value: 0 }, $unset: { rupeesUnit: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      return res.status(200).json({ success: true, data: null });
    }

    if (value == null) {
      return res.status(400).json({
        success: false,
        message: 'value is required when setting a rate',
      });
    }

    if (!['AMOUNT', 'PERCENTAGE'].includes(chargeType)) {
      return res.status(400).json({
        success: false,
        message: 'chargeType must be AMOUNT or PERCENTAGE',
      });
    }

    // The edit screen charges per gram and no longer offers the choice, so an
    // omitted unit is the per-gram default rather than a bad request.
    const resolvedRupeesUnit = rupeesUnit || 'Per Gram';
    if (chargeType === 'AMOUNT' && !['Per Gram', 'Per 10 Gram'].includes(resolvedRupeesUnit)) {
      return res.status(400).json({
        success: false,
        message: 'rupeesUnit must be "Per Gram" or "Per 10 Gram" when chargeType is AMOUNT',
      });
    }

    if (weightBasis != null && !['net', 'gross'].includes(weightBasis)) {
      return res.status(400).json({
        success: false,
        message: 'weightBasis must be "net" or "gross"',
      });
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return res.status(400).json({
        success: false,
        message: 'value must be a positive number',
      });
    }

    if (chargeType === 'PERCENTAGE' && numericValue > 100) {
      return res.status(400).json({
        success: false,
        message: 'Percentage value must be between 0 and 100',
      });
    }

    const updateData = { chargeType, value: numericValue };
    if (chargeType === 'AMOUNT') {
      updateData.rupeesUnit = resolvedRupeesUnit;
      updateData.weightBasis = weightBasis || 'gross';
    } else {
      updateData.$unset = { rupeesUnit: 1 };
    }

    const labourRate = await LabourRate.findOneAndUpdate(
      scopedQuery,
      updateData,
      { new: true, upsert: true },
    );

    res.status(200).json({ success: true, data: labourRate });
  } catch (error) {
    console.error('Upsert Labour Rate Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server Error' });
  }
};

module.exports = {
  updateGoldRate,
  updateGoldRateVisibility,
  getGoldRates,
  getGoldTaxSettings,
  updateGoldTaxSettings,
  addOrUpdateDiamondRate,
  getDiamondRates,
  lookupDiamondRate,
  deleteDiamondRate,
  addOrUpdateColorstoneRate,
  getColorstoneRates,
  deleteColorstoneRate,
  getLabourRate,
  upsertLabourRate,
};

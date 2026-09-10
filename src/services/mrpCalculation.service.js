const rateCalculationService = require('./rateCalculation.service');
const redisService = require('./redis.service');
const LabourRate = require('../models/labourRate.model');
const DiamondRate = require('../models/diamondRate.model');
const ColorstoneRate = require('../models/colorstoneRate.model');
const GoldTaxSetting = require('../models/goldTaxSetting.model');
const Employee = require('../models/employee.model');
const { aggregateJewelleryMrp } = require('./pricingAggregation.service');
const { assertScanAccess } = require('../utils/scanAccess');
const { settingsScope, findScopedSetting, findScopedRows } = require('./userScope.service');
const { findDiamondRateMatch, normalizeKey } = require('./diamondRateLookup.service');

/**
 * The MRP calculation, shared by the calculate endpoint the review card
 * calls and by the analysis itself — which prices the scan the moment the
 * reading exists, so the card can open with values and price together
 * instead of paying a further round trip for the price.
 */

const normalizeBool = (value) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return false;
};

const getPermissionValue = (permissions, key) => {
  if (!permissions) return false;
  if (typeof permissions.get === 'function') {
    return normalizeBool(permissions.get(key));
  }
  return normalizeBool(permissions[key]);
};

const toNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const resolveScanForCalculation = async (requestedScanId, session) => {
  if (!requestedScanId) {
    return { resolvedScanId: null, scan: null };
  }

  let scan = await redisService.getScan(requestedScanId);
  if (scan) {
    assertScanAccess(scan, session);
    return { resolvedScanId: requestedScanId, scan };
  }

  if (!session?.businessId || !session?.userId) {
    const err = new Error('Scan not found. Please start a new scan session.');
    err.statusCode = 404;
    throw err;
  }

  const latestScanId = await redisService.getLatestScanIdForUser(session.businessId, session.userId);
  if (!latestScanId || latestScanId === requestedScanId) {
    const err = new Error('Scan not found. Please start a new scan session.');
    err.statusCode = 404;
    throw err;
  }

  scan = await redisService.getScan(latestScanId);
  if (!scan) {
    const err = new Error('Scan session expired. Please scan again.');
    err.statusCode = 404;
    throw err;
  }

  assertScanAccess(scan, session);
  return { resolvedScanId: latestScanId, scan };
};

/**
 * Computes the MRP for one set of inputs. `scan` may be passed in when the
 * caller already holds the session (the analysis does), which skips the
 * lookup. Throws an error with statusCode 403 for an employee without a
 * roster record.
 */
async function computeMrp({ user, sessionContext, scanId, input, scan: knownScan = null }) {
  const {
    jewelleryType,
    netWt,
    purityKarat,
    customPurityPercent,
    diamonds,
    colorstones,
    labourChargeAmount,
    labourChargeUnit,
    labourWeightBasis,
    grossWt,
    otherCharges,
    calculationMode,
  } = input || {};

  const businessId = user.businessId;

  // These reads are independent. Running them together keeps the preview
  // calculation bounded by the slowest lookup instead of their combined
  // latency.
  const employeePromise = user?.role === 'EMP'
    ? Employee.findById(user.userId).select('permissions')
    : Promise.resolve(null);
  const [liveRatesData, globalLabourDoc, scanResolution, employee] = await Promise.all([
    rateCalculationService.getLiveGoldRates(businessId, settingsScope(user)),
    // The calculating account's own labour charge when saved, else the
    // shop's; a stored NONE row means explicitly no labour charge.
    findScopedSetting(LabourRate, settingsScope(user)),
    knownScan
      ? Promise.resolve({ resolvedScanId: scanId, scan: knownScan })
      : resolveScanForCalculation(scanId, sessionContext),
    employeePromise,
  ]);
  const globalLabour = globalLabourDoc && globalLabourDoc.chargeType !== 'NONE' ? globalLabourDoc : null;
  const { resolvedScanId, scan } = scanResolution;

  // Find the karat purity from the database rows (normalize '14K' vs '14Kt')
  const normalizedKarat = purityKarat ? purityKarat.replace(/t$/i, '').toUpperCase() : '';
  const karatData = liveRatesData.karatRates.find(r => r.carat.replace(/t$/i, '').toUpperCase() === normalizedKarat);
  const karatPurityPercent = karatData ? karatData.purity : 0;

  // If DB lookup failed, derive a fallback purity percent from the karat value
  // e.g. 24K -> 100%, 18K -> 75% (karat/24 * 100)
  let fallbackPurityPercent = 0;
  if (purityKarat) {
    const numericKarat = Number(String(purityKarat).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(numericKarat) && numericKarat > 0) {
      fallbackPurityPercent = Math.min(100, (numericKarat / 24) * 100);
    }
  }

  const labourCharge = globalLabour
    ? { type: globalLabour.chargeType, value: globalLabour.value, rupeesUnit: globalLabour.rupeesUnit }
    : null;

  const hasCustomPurityPercent =
    customPurityPercent !== undefined &&
    customPurityPercent !== null &&
    String(customPurityPercent).trim() !== '';
  let effectivePurityPercent = hasCustomPurityPercent
    ? toNumber(customPurityPercent)
    : (karatPurityPercent || fallbackPurityPercent);
  effectivePurityPercent = Math.max(0, Math.min(100, effectivePurityPercent));

  // Diamond amount, line by line and discount-aware
  const diamondLineItems = Array.isArray(diamonds)
    ? diamonds.map((dia, index) => {
        const wt = toNumber(dia.weight);
        const rate = toNumber(dia.rate);
        const discountPercent = Math.max(0, Math.min(100, toNumber(dia.discountPercent)));
        const baseAmount = wt * rate;
        const amount = baseAmount - baseAmount * (discountPercent / 100);
        return { index: index + 1, weight: wt, rate, discountPercent, amount };
      })
    : [];
  const diamondAmount = diamondLineItems.reduce((sum, item) => sum + item.amount, 0);

  // Colorstone amount, line by line
  const colorstoneLineItems = Array.isArray(colorstones)
    ? colorstones.map((cs, index) => {
        const wt = toNumber(cs.weight);
        const rate = toNumber(cs.rate);
        return { index: index + 1, weight: wt, rate, amount: wt * rate };
      })
    : [];
  const colorstoneAmount = colorstoneLineItems.reduce((sum, item) => sum + item.amount, 0);

  // Pure weight, selected gold rate and labour charge
  const numericNetWt = toNumber(netWt);
  const numericGrossWt = toNumber(grossWt);
  const pureWeight = numericNetWt * (effectivePurityPercent / 100);

  const hasManualLabourRate =
    labourChargeAmount !== undefined && labourChargeAmount !== null && String(labourChargeAmount).trim() !== '';
  const labourRatePerUnit = hasManualLabourRate
    ? toNumber(labourChargeAmount)
    : toNumber(labourCharge?.value);
  const resolvedLabourUnit = labourChargeUnit || labourCharge?.rupeesUnit || 'Per Gram';
  const resolvedLabourWeightBasis = labourWeightBasis === 'gross' ? 'gross' : 'net';
  const labourWeightGrams =
    resolvedLabourWeightBasis === 'gross'
      ? (numericGrossWt > 0 ? numericGrossWt : numericNetWt)
      : numericNetWt;

  let labourAmount = 0;
  if (labourRatePerUnit > 0) {
    labourAmount =
      resolvedLabourUnit === 'Per 10 Gram'
        ? labourWeightGrams * (labourRatePerUnit / 10)
        : labourWeightGrams * labourRatePerUnit;
  }

  let resolvedMode = calculationMode || scan?.calculationMode || 'rtgs';

  if (user?.role === 'EMP') {
    if (!employee) {
      const err = new Error('Unauthorized');
      err.statusCode = 403;
      err.code = 'EMPLOYEE_NOT_FOUND';
      throw err;
    }

    const allowRtgs = getPermissionValue(employee.permissions, 'scan_rate_rtgs');
    const allowCash = getPermissionValue(employee.permissions, 'scan_rate_cash');

    if (allowRtgs && !allowCash) {
      resolvedMode = 'rtgs';
    } else if (allowCash && !allowRtgs) {
      resolvedMode = 'cash';
    } else if (allowRtgs && allowCash) {
      resolvedMode = resolvedMode === 'cash' ? 'cash' : 'rtgs';
    } else {
      resolvedMode = 'rtgs';
    }
  } else {
    resolvedMode = resolvedMode === 'cash' ? 'cash' : 'rtgs';
  }

  // Gold amount
  let baseGoldRatePer10g = resolvedMode === 'cash'
    ? liveRatesData.taxSettings.cashFinalRate
    : liveRatesData.taxSettings.rtgsFinalRate;

  // Fallback if cache is old and doesn't contain pre-calculated final rates
  if (baseGoldRatePer10g === undefined && liveRatesData.mcxLiveRate) {
    const mcxFinalRate =
      liveRatesData.taxSettings?.mcxFinalRate ??
      liveRatesData.mcxFinalRate ??
      (liveRatesData.mcxLiveRate + (liveRatesData.taxSettings?.mcxChangeBy || 0));

    const supremeChange =
      resolvedMode === 'cash'
        ? (liveRatesData.supremeChanges?.cashChange || 0)
        : (liveRatesData.supremeChanges?.rtgsChange || 0);
    const businessChange =
      resolvedMode === 'cash'
        ? (liveRatesData.taxSettings?.cashChangeBy || 0)
        : (liveRatesData.taxSettings?.rtgsChangeBy || 0);

    baseGoldRatePer10g = mcxFinalRate + supremeChange + businessChange;
  }

  const selected24kGoldRatePerGram = (baseGoldRatePer10g || 0) / 10;
  const purityAdjustedGoldRatePerGram = selected24kGoldRatePerGram * (effectivePurityPercent / 100);

  // Gold Amount = Pure Weight × selected 24K RTGS/Cash live rate per gram
  const goldAmount = pureWeight * selected24kGoldRatePerGram;

  const otherChargesAmount = toNumber(otherCharges);

  const aggregation = aggregateJewelleryMrp({
    goldAmount,
    diamondAmount,
    colorstoneAmount,
    labourAmount,
    otherChargesAmount,
  });

  const subtotal = aggregation.subtotal;
  const finalMRP = aggregation.finalMRP;

  const labourChargeType = hasManualLabourRate
    ? 'AMOUNT_MANUAL'
    : labourCharge
      ? `${labourCharge.type || 'AMOUNT'}_GLOBAL`
      : 'NONE';

  console.info('[MRP_CALC_AUDIT]', JSON.stringify({
    scanId: resolvedScanId || scanId,
    selectedKarat: purityKarat || '',
    effectivePurityPercent,
    netWeight: numericNetWt,
    pureWeight,
    selected24kGoldRatePerGram,
    purityAdjustedGoldRatePerGram,
    goldAmount: aggregation.goldAmount,
    diamondLineItems,
    colorstoneLineItems,
    labourAmount: aggregation.labourAmount,
    otherChargesAmount: aggregation.otherChargesAmount,
    subtotal,
    finalMRP,
  }));

  const resultData = {
    breakdown: {
      diamondAmount: aggregation.diamondAmount,
      colorstoneAmount: aggregation.colorstoneAmount,
      pureWeight,
      goldRateApplied: selected24kGoldRatePerGram,
      goldAmount: aggregation.goldAmount,
      labourAmount: aggregation.labourAmount,
      labourChargeType,
      otherCharges: aggregation.otherChargesAmount,
      subtotal,
    },
    finalMRP,
  };

  const snapshot = {
    jewelleryType,
    netWt: numericNetWt,
    grossWt: numericGrossWt,
    purityKarat,
    customPurityPercent: hasCustomPurityPercent ? effectivePurityPercent : null,
    diamonds,
    colorstones,
    otherCharges: otherChargesAmount,
    calculationMode: resolvedMode,
  };

  return { resultData, resolvedScanId, scan, snapshot, resolvedMode };
}

// ── Deriving inputs from a fresh reading ──────────────────────────────

/** Fineness standards (per mille) and the karat each stands for. */
const FINENESS_STANDARDS = [
  [999, '24K'], [958, '23K'], [916, '22K'], [875, '21K'], [833, '20K'],
  [750, '18K'], [625, '15K'], [585, '14K'], [417, '10K'], [375, '9K'],
];

/** "18K", "18 KT", "18k" → "18K"; anything else → "". */
function normalizeKarat(value) {
  const match = String(value ?? '').match(/(\d{1,2})\s*k/i);
  return match ? `${Number(match[1])}K` : '';
}

/** "750", "75", "91.6" → the nearest standard karat, or "". */
function karatFromFineness(value) {
  const digits = String(value ?? '').replace(/[^0-9.]/g, '');
  if (!digits) return '';
  const parsed = Number.parseFloat(digits);
  if (!Number.isFinite(parsed) || parsed <= 0) return '';
  const perMille = parsed <= 100 ? parsed * 10 : parsed;
  if (perMille < 300 || perMille > 1000) return '';
  let closest = '';
  let distance = Number.POSITIVE_INFINITY;
  for (const [standard, karat] of FINENESS_STANDARDS) {
    const gap = Math.abs(perMille - standard);
    if (gap < distance) {
      distance = gap;
      closest = karat;
    }
  }
  return closest;
}

/** The karat a reading implies, the way the app reads it; 14K when nothing does. */
function resolveKaratFromReading(structuredData) {
  const data = structuredData || {};
  return (
    normalizeKarat(data.karat) ||
    normalizeKarat(data.purity) ||
    karatFromFineness(data.karat) ||
    karatFromFineness(data.purity) ||
    '14K'
  );
}

function parseStoneList(raw) {
  if (raw == null) return [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
}

const stoneField = (stone, key) => {
  const value = stone?.[key];
  if (value && typeof value === 'object' && 'value' in value) return String(value.value ?? '').trim();
  return String(value ?? '').trim();
};

/**
 * Builds the calculation input straight from a reading: weights and karat
 * from the tag, stone rates looked up in the account's own rate tables (or
 * the shop's), labour left to the shop's global charge, the mode from the
 * scan session. Mirrors what the app derives on its side for the first
 * price, so the two agree in the normal case.
 */
async function deriveInputFromReading({ user, structuredData, scan }) {
  const data = structuredData || {};
  const scope = settingsScope(user);
  const [diamondRows, colorstoneRows, taxSettings] = await Promise.all([
    findScopedRows(DiamondRate, scope),
    findScopedRows(ColorstoneRate, scope),
    findScopedSetting(GoldTaxSetting, scope),
  ]);
  const diamondRowsPlain = diamondRows.map((row) => (typeof row.toObject === 'function' ? row.toObject() : row));

  const globalPacketCode = stoneField(data, 'packetCode');
  const diamonds = parseStoneList(data.diamonds)
    .map((stone) => {
      const weight = toNumber(stoneField(stone, 'weight'));
      if (weight <= 0) return null;
      const match = findDiamondRateMatch(diamondRowsPlain, {
        color: stoneField(stone, 'color'),
        clarity: stoneField(stone, 'clarity'),
        shape: stoneField(stone, 'shape'),
        packetCode: stoneField(stone, 'packetCode') || globalPacketCode,
      });
      return {
        weight,
        rate: match ? toNumber(match.rate) : toNumber(stoneField(stone, 'rate')),
        discountPercent: toNumber(stoneField(stone, 'discountPercent')),
      };
    })
    .filter(Boolean);

  const colorstones = parseStoneList(data.colorstones)
    .map((stone) => {
      const weight = toNumber(stoneField(stone, 'weight'));
      if (weight <= 0) return null;
      const colorKey = normalizeKey(stoneField(stone, 'color'));
      const clarityKey = normalizeKey(stoneField(stone, 'clarity'));
      const match = colorstoneRows.find(
        (row) => normalizeKey(row.color) === colorKey && normalizeKey(row.clarity) === clarityKey,
      );
      return { weight, rate: match ? toNumber(match.rate) : toNumber(stoneField(stone, 'rate')) };
    })
    .filter(Boolean);

  return {
    jewelleryType: scan?.jewelleryType || data.jewelleryType || '',
    netWt: toNumber(stoneField(data, 'netWeight')),
    grossWt: toNumber(stoneField(data, 'grossWeight')),
    purityKarat: resolveKaratFromReading(data),
    diamonds,
    colorstones,
    otherCharges: 0,
    calculationMode:
      scan?.calculationMode || (taxSettings?.scannerCalculationUse === 'cash' ? 'cash' : 'rtgs'),
  };
}

module.exports = {
  computeMrp,
  deriveInputFromReading,
  resolveKaratFromReading,
  resolveScanForCalculation,
  toNumber,
};

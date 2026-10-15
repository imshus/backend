const rateCalculationService = require('./rateCalculation.service');
const redisService = require('./redis.service');
const LabourRate = require('../models/labourRate.model');
const ItemCode = require('../models/itemCode.model');
const WastageCode = require('../models/wastageCode.model');
const { resolveWastage, findWastageRow } = require('./wastageResolution.service');
const { tagIdentifiersOf } = require('../utils/tagIdentifiers');
const DiamondRate = require('../models/diamondRate.model');
const ColorstoneRate = require('../models/colorstoneRate.model');
const GoldTaxSetting = require('../models/goldTaxSetting.model');
const Employee = require('../models/employee.model');
const pyCalcEngine = require('./pyCalcEngine');
const { assertScanAccess } = require('../utils/scanAccess');
const { roundHalfUp } = require('../utils/money');
const { settingsScope, findScopedSetting, findScopedRows } = require('./userScope.service');
const { findDiamondRateMatch } = require('./diamondRateLookup.service');
const { LABOUR_UNIT_PERCENT } = require('./pricingMath');
const {
  ratesUnavailable,
  readFigure,
  resolveKaratFromReading,
  stoneUnitOf,
  stoneUnitInText,
  findItemOnTag,
  findColorstoneRateMatch,
  parseTagLabour,
  validateCalculationInput,
} = require('./pricingInputs');

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
 * The reads a price needs that do not depend on what the tag says, started
 * before the reading exists. /analyze starts them beside the model call, so
 * the price that follows the reading waits on none of them. The live rates
 * are only warmed here: computeMrp still asks for them afterwards, which is
 * then a cache hit, so the price uses the board as it stands at that moment.
 * A read that fails here fails the price exactly as it would have, when the
 * price awaits it.
 */
function prefetchPricingReads(user) {
  const scope = settingsScope(user);
  const reads = {
    diamondRows: findScopedRows(DiamondRate, scope),
    colorstoneRows: findScopedRows(ColorstoneRate, scope),
    taxSettings: findScopedSetting(GoldTaxSetting, scope),
    labour: findScopedSetting(LabourRate, scope),
    employee: user?.role === 'EMP'
      ? Employee.findById(user.userId).select('permissions').exec()
      : Promise.resolve(null),
    wastageRows: findScopedRows(WastageCode, scope),
    itemRows: findScopedRows(ItemCode, scope),
    liveRatesWarm: rateCalculationService.getLiveGoldRates(user?.businessId, scope),
  };
  // Nothing may count as unhandled while the model is still answering.
  for (const read of Object.values(reads)) read.catch(() => {});
  return reads;
}

/** Blank and repeated (ignoring case) identifiers dropped, the order kept. */
function distinctIdentifiers(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const key = value.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * The labour a price charges, first that applies:
 *   1. the figure the request carries: rupees per gram or per 10 g, or a
 *      percent of the gold value ("12%", or the unit 'Percent');
 *   2. the matched item's own labour in Masters -> Item Code, in rupees per
 *      gram;
 *   3. the shop's labour charge: an AMOUNT per its own unit, or a PERCENTAGE
 *      of the gold value.
 * The weight a per-gram charge runs on is the request's when it names one,
 * else the one the shop's labour charge was saved against.
 */
function resolveLabour({ manualLabour, labourWeightBasis, itemRow, globalLabour }) {
  const basis = labourWeightBasis || (globalLabour?.weightBasis === 'gross' ? 'gross' : 'net');
  if (manualLabour) {
    return {
      ratePerUnit: manualLabour.amount,
      unit: manualLabour.unit,
      basis,
      chargeType: manualLabour.unit === LABOUR_UNIT_PERCENT ? 'PERCENTAGE_MANUAL' : 'AMOUNT_MANUAL',
    };
  }
  const itemLabour = itemRow?.labour;
  if (typeof itemLabour === 'number' && Number.isFinite(itemLabour) && itemLabour >= 0) {
    return { ratePerUnit: itemLabour, unit: 'Per Gram', basis, chargeType: 'AMOUNT_ITEM' };
  }
  if (globalLabour) {
    const value = Math.max(0, toNumber(globalLabour.value));
    if (globalLabour.chargeType === 'PERCENTAGE') {
      return { ratePerUnit: value, unit: LABOUR_UNIT_PERCENT, basis, chargeType: 'PERCENTAGE_GLOBAL' };
    }
    return {
      ratePerUnit: value,
      unit: globalLabour.rupeesUnit === 'Per 10 Gram' ? 'Per 10 Gram' : 'Per Gram',
      basis,
      chargeType: `${globalLabour.chargeType || 'AMOUNT'}_GLOBAL`,
    };
  }
  return { ratePerUnit: 0, unit: 'Per Gram', basis, chargeType: 'NONE' };
}

/**
 * The 24K rate per 10 g a price is worked on, in the mode chosen. With no
 * live rate there is no price: RATES_UNAVAILABLE, never a gold line at Rs 0.
 */
function selectGoldRatePer10g(liveRatesData, mode) {
  const taxSettings = liveRatesData?.taxSettings || {};
  let rate = mode === 'cash' ? taxSettings.cashFinalRate : taxSettings.rtgsFinalRate;

  // A cached entry from a build that did not store the final rates.
  if ((rate === undefined || rate === null) && liveRatesData?.mcxLiveRate) {
    const mcxFinalRate =
      taxSettings.mcxFinalRate ??
      liveRatesData.mcxFinalRate ??
      (liveRatesData.mcxLiveRate + (taxSettings.mcxChangeBy || 0));
    const supremeChange =
      mode === 'cash'
        ? (liveRatesData.supremeChanges?.cashChange || 0)
        : (liveRatesData.supremeChanges?.rtgsChange || 0);
    const businessChange =
      mode === 'cash' ? (taxSettings.cashChangeBy || 0) : (taxSettings.rtgsChangeBy || 0);
    rate = roundHalfUp(mcxFinalRate + supremeChange + businessChange);
  }

  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw ratesUnavailable(`no ${mode === 'cash' ? 'cash' : 'RTGS'} gold rate`);
  }
  return rate;
}

/**
 * Computes the MRP for one set of inputs. `scan` may be passed in when the
 * caller already holds the session (the analysis does), which skips the
 * lookup. `prefetched` is what prefetchPricingReads started. Throws:
 *   INVALID_PRICING_INPUT (400) for a body that cannot be priced, before
 *     anything is read;
 *   EMPLOYEE_NOT_FOUND (403) for an employee without a roster record;
 *   RATES_UNAVAILABLE (503) when there is no live gold rate to price on.
 */
async function computeMrp({ user, sessionContext, scanId, input, scan: knownScan = null, prefetched = null }) {
  const request = validateCalculationInput(input);

  const businessId = user.businessId;
  const scope = settingsScope(user);

  // These reads are independent. Running them together keeps the preview
  // calculation bounded by the slowest lookup instead of their combined
  // latency.
  const employeePromise = prefetched?.employee
    || (user?.role === 'EMP'
      ? Employee.findById(user.userId).select('permissions')
      : Promise.resolve(null));
  // Every identifier on the tag, the item number first, then each number the
  // reader set aside. The item they name in Masters -> Item Code carries the
  // shop's wastage and labour for it; a code in Masters -> Wastage is the
  // scan's wastage code.
  const identifiers = distinctIdentifiers([request.itemCode, ...request.tagIdentifiers]);
  const itemRowsPromise = identifiers.length
    ? prefetched?.itemRows || findScopedRows(ItemCode, scope)
    : Promise.resolve([]);
  const wastageRowsPromise = identifiers.length
    ? prefetched?.wastageRows || findScopedRows(WastageCode, scope)
    : Promise.resolve([]);
  // Once the warm-up has settled, this is a cache hit that still checks the
  // board has not moved since.
  const liveRatesPromise = prefetched?.liveRatesWarm
    ? prefetched.liveRatesWarm
      .catch(() => {})
      .then(() => rateCalculationService.getLiveGoldRates(businessId, scope))
    : rateCalculationService.getLiveGoldRates(businessId, scope);
  const [liveRatesData, globalLabourDoc, scanResolution, employee, itemRows, wastageRows] = await Promise.all([
    liveRatesPromise,
    // The calculating account's own labour charge when saved, else the
    // shop's; a stored NONE row means explicitly no labour charge.
    prefetched?.labour || findScopedSetting(LabourRate, scope),
    knownScan
      ? Promise.resolve({ resolvedScanId: scanId, scan: knownScan })
      : resolveScanForCalculation(scanId, sessionContext),
    employeePromise,
    itemRowsPromise,
    wastageRowsPromise,
  ]);
  const globalLabour = globalLabourDoc && globalLabourDoc.chargeType !== 'NONE' ? globalLabourDoc : null;
  const { resolvedScanId, scan } = scanResolution;

  // The karat's purity in the shop's gold rows ('22Kt' is 22K); a karat with
  // no row (23K, 21K, 15K, 10K) is priced at karat/24 by pricingMath.
  const karatRows = Array.isArray(liveRatesData?.karatRates) ? liveRatesData.karatRates : [];
  const karatData = request.purityKarat
    ? karatRows.find((row) => String(row?.carat ?? '').replace(/t$/i, '').toUpperCase() === request.purityKarat)
    : null;
  const karatPurityPercent = karatData ? toNumber(karatData.purity) : 0;
  const karatNumber = request.purityKarat ? Number(request.purityKarat.slice(0, -1)) : 0;

  let resolvedMode = request.calculationMode || scan?.calculationMode || 'rtgs';

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

  const goldRatePer10g = selectGoldRatePer10g(liveRatesData, resolvedMode);

  // The item the tag's number names: GR10286 is item GR, the code followed
  // by the piece's running number (the app's rule). The identifier that
  // named it is tried first for a wastage code too, as the app sends it.
  const itemMatch = findItemOnTag(identifiers, itemRows);
  const itemRow = itemMatch?.row || null;
  const wastageCandidates = itemMatch
    ? [itemMatch.identifier, ...identifiers.filter((value) => value !== itemMatch.identifier)]
    : identifiers;
  const wastageRow = findWastageRow(wastageRows, wastageCandidates);
  const wastage = resolveWastage({ manualPercent: request.wastagePercent, wastageRow, itemRow });

  const labour = resolveLabour({
    manualLabour: request.manualLabour,
    labourWeightBasis: request.labourWeightBasis,
    itemRow,
    globalLabour,
  });

  // The arithmetic itself: pricingMath, in the Python worker when
  // CALC_ENGINE=python and it answers in time, else in Node.
  const priced = await pyCalcEngine.computePricing({
    netWt: request.netWt,
    grossWt: request.grossWt,
    customPurityPercent: request.customPurityPercent,
    karatPurityPercent,
    karatNumber,
    goldRatePer10g,
    diamonds: request.diamonds,
    colorstones: request.colorstones,
    labourRatePerUnit: labour.ratePerUnit,
    labourUnit: labour.unit,
    labourWeightBasis: labour.basis,
    wastagePercent: wastage.percent,
    otherCharges: request.otherCharges,
    labourChargeType: labour.chargeType,
    wastageCode: wastage.code,
  });
  const { breakdown, finalMRP, finalMRPRounded, effectivePurityPercent } = priced;

  console.info('[MRP_CALC_AUDIT]', JSON.stringify({
    scanId: resolvedScanId || scanId,
    selectedKarat: request.purityKarat,
    effectivePurityPercent,
    netWeight: breakdown.netWeightUsed,
    netWeightEstimated: breakdown.netWeightEstimated,
    pureWeight: breakdown.pureWeight,
    selected24kGoldRatePerGram: breakdown.goldRateApplied,
    purityAdjustedGoldRatePerGram: priced.purityAdjustedGoldRatePerGram,
    goldAmount: breakdown.goldAmount,
    diamondLineItems: priced.diamondLineItems,
    colorstoneLineItems: priced.colorstoneLineItems,
    itemCode: itemRow ? String(itemRow.code || '') : '',
    labourChargeType: breakdown.labourChargeType,
    labourAmount: breakdown.labourAmount,
    wastagePercent: breakdown.wastagePercent,
    wastageWeightGrams: breakdown.wastageWeightGrams,
    wastageAmount: breakdown.wastageAmount,
    otherChargesAmount: breakdown.otherCharges,
    subtotal: breakdown.subtotal,
    finalMRP,
    finalMRPRounded,
  }));

  // finalMRP as worked out; finalMRPRounded is the price to the rupee,
  // commercial half-up, the figure to show and bill.
  const resultData = { breakdown, finalMRP, finalMRPRounded };

  const snapshot = {
    jewelleryType: request.jewelleryType,
    netWt: request.netWt,
    grossWt: request.grossWt,
    purityKarat: request.purityKarat,
    customPurityPercent: request.customPurityPercent !== null ? effectivePurityPercent : null,
    diamonds: request.diamonds,
    colorstones: request.colorstones,
    otherCharges: request.otherCharges,
    calculationMode: resolvedMode,
  };

  return { resultData, resolvedScanId, scan, snapshot, resolvedMode };
}

// ── Deriving inputs from a fresh reading ──────────────────────────────

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

const plainRows = (rows) =>
  (Array.isArray(rows) ? rows : []).map((row) => (typeof row?.toObject === 'function' ? row.toObject() : row));

/** A stone's weight off the tag and the unit it is in: the reader's unit, else one printed after the figure, else carats. */
const stoneWeightOf = (stone) => {
  const text = stoneField(stone, 'weight');
  return {
    weight: readFigure(text),
    unit: stoneUnitOf(stoneField(stone, 'unit')) || stoneUnitInText(text) || 'ct',
  };
};

/**
 * Builds the calculation input straight from a reading, the way the app
 * builds its own request from the same reading (utils/pricingPrefetch.ts and
 * the review card's set-up), so the first price and the card's agree:
 *   - weights, rates and other charges are the first figure in each field;
 *     a blank net weight stays 0 and pricingMath works it out from the
 *     gross weight;
 *   - the karat from the karat field, the purity (tunch) or a fineness;
 *   - stone weights in their printed unit; rates from the account's own
 *     tables (or the shop's), a stone's packet code first;
 *   - labour the tag prints (on the net weight, as the app charges it);
 *     otherwise computeMrp charges the item's labour or the shop's, on the
 *     weight the shop's charge was saved against;
 *   - the item code and every identifier on the tag, for the Masters item
 *     and wastage code; the mode from the scan session.
 */
async function deriveInputFromReading({ user, structuredData, scan, prefetched = null }) {
  const data = structuredData || {};
  const scope = settingsScope(user);
  const [diamondRows, colorstoneRows, taxSettings] = await Promise.all([
    prefetched?.diamondRows || findScopedRows(DiamondRate, scope),
    prefetched?.colorstoneRows || findScopedRows(ColorstoneRate, scope),
    prefetched?.taxSettings || findScopedSetting(GoldTaxSetting, scope),
  ]);
  const diamondRowsPlain = plainRows(diamondRows);
  const colorstoneRowsPlain = plainRows(colorstoneRows);

  const globalPacketCode = stoneField(data, 'packetCode');
  const diamonds = parseStoneList(data.diamonds)
    .map((stone) => {
      const { weight, unit } = stoneWeightOf(stone);
      if (weight <= 0) return null;
      const match = findDiamondRateMatch(diamondRowsPlain, {
        color: stoneField(stone, 'color'),
        clarity: stoneField(stone, 'clarity'),
        shape: stoneField(stone, 'shape'),
        packetCode: stoneField(stone, 'packetCode') || globalPacketCode,
      });
      return {
        weight,
        rate: match ? readFigure(match.rate) : readFigure(stoneField(stone, 'rate')),
        discountPercent: Math.min(100, readFigure(stoneField(stone, 'discountPercent'))),
        unit,
      };
    })
    .filter(Boolean);

  const colorstones = parseStoneList(data.colorstones)
    .map((stone) => {
      const { weight, unit } = stoneWeightOf(stone);
      if (weight <= 0) return null;
      const match = findColorstoneRateMatch(colorstoneRowsPlain, {
        packetCode: stoneField(stone, 'packetCode') || globalPacketCode,
        color: stoneField(stone, 'color'),
        clarity: stoneField(stone, 'clarity'),
      });
      return { weight, rate: match ? readFigure(match.rate) : readFigure(stoneField(stone, 'rate')), unit };
    })
    .filter(Boolean);

  const tagLabour = parseTagLabour(stoneField(data, 'labour'));
  let labourFields = {};
  if (tagLabour?.unit === LABOUR_UNIT_PERCENT) {
    labourFields = { labourChargeAmount: String(tagLabour.amount), labourChargeUnit: LABOUR_UNIT_PERCENT };
  } else if (tagLabour) {
    labourFields = {
      labourChargeAmount: String(tagLabour.amount),
      labourChargeUnit: tagLabour.unit,
      labourWeightBasis: 'net',
    };
  }

  const serialNumber = stoneField(data, 'serialNumber');

  return {
    jewelleryType: scan?.jewelleryType || stoneField(data, 'jewelleryType'),
    netWt: readFigure(stoneField(data, 'netWeight')),
    grossWt: readFigure(stoneField(data, 'grossWeight')),
    purityKarat: resolveKaratFromReading(data),
    diamonds,
    colorstones,
    ...labourFields,
    otherCharges: readFigure(stoneField(data, 'otherCharges')),
    ...(serialNumber ? { itemCode: serialNumber } : {}),
    // So the price worked out with the reading finds the Masters item and
    // a Masters -> Wastage code printed anywhere on the tag, as the app's
    // own pricing does.
    tagIdentifiers: tagIdentifiersOf({
      structuredData: data,
      unknownFields: scan?.analysisResult?.unknownFields,
    }),
    calculationMode:
      scan?.calculationMode || (taxSettings?.scannerCalculationUse === 'cash' ? 'cash' : 'rtgs'),
  };
}

module.exports = {
  computeMrp,
  deriveInputFromReading,
  prefetchPricingReads,
  resolveKaratFromReading,
  resolveScanForCalculation,
  toNumber,
};

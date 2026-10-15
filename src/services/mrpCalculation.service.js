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
const { assertScanAccess, scanExpiredError } = require('../utils/scanAccess');
const { roundHalfUp } = require('../utils/money');
const { settingsScope, findScopedSetting, findScopedRows } = require('./userScope.service');
const { findDiamondRateMatch } = require('./diamondRateLookup.service');
const { LABOUR_UNIT_PERCENT, computePricing } = require('./pricingMath');
const {
  ratesUnavailable,
  readFigure,
  resolveKaratFromReading,
  stoneUnitOf,
  stoneUnitInText,
  findItemOnTag,
  findItemExactly,
  findColorstoneRateMatch,
  itemLabourOf,
  appLabourFields,
  legacyAppColorstoneRate,
  CURRENT_PRICING_RULES,
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

  // Held in memory, a record is dropped once its scan is over (scanStore),
  // while its card can still be open. The card sends every input a price
  // needs; the record only lends the cash/RTGS fallback and the place the
  // snapshot is kept. So it is priced from the request alone and nothing is
  // written: not a 404, which every build's card ignores (keeping the old
  // MRP beside the edited inputs), and never another scan's record.
  if (redisService.scansInMemory()) {
    console.info('[MRP_CALC_WITHOUT_SCAN]', { scanId: String(requestedScanId) });
    return { resolvedScanId: null, scan: null };
  }

  // Redis: no record is 404 SCAN_EXPIRED ("Please scan again"), unless the
  // caller has a newer scan.
  if (!session?.businessId || !session?.userId) {
    throw scanExpiredError();
  }

  const latestScanId = await redisService.getLatestScanIdForUser(session.businessId, session.userId);
  if (!latestScanId || latestScanId === requestedScanId) {
    throw scanExpiredError();
  }

  scan = await redisService.getScan(latestScanId);
  if (!scan) {
    throw scanExpiredError();
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
 *   2. the matched item's own labour in Masters -> Item Code, in the unit
 *      it was saved in (per gram, per 10 g, or a percent of the gold value);
 *      rules 2 only, as the builds before it never charged it;
 *   3. the shop's labour charge: an AMOUNT per its own unit, or a PERCENTAGE
 *      of the gold value.
 * The weight a per-gram charge runs on is the request's when it names one,
 * else the one the shop's labour charge was saved against.
 *
 * The app (1.0.367) fills the card's labour box with the tag's labour, else
 * the item's, else the shop's, and sends it as the request's figure, so the
 * box, the price and the invoice are one figure whatever the shop's labour
 * type; 2 and 3 price a request that sends none.
 */
function resolveLabour({ manualLabour, labourWeightBasis, itemRow, globalLabour, rules }) {
  const basis = labourWeightBasis || (globalLabour?.weightBasis === 'gross' ? 'gross' : 'net');
  if (manualLabour) {
    return {
      ratePerUnit: manualLabour.amount,
      unit: manualLabour.unit,
      basis,
      chargeType: manualLabour.unit === LABOUR_UNIT_PERCENT ? 'PERCENTAGE_MANUAL' : 'AMOUNT_MANUAL',
    };
  }
  const itemLabour = rules >= CURRENT_PRICING_RULES ? itemLabourOf(itemRow) : null;
  if (itemLabour) {
    return {
      ratePerUnit: itemLabour.amount,
      unit: itemLabour.unit,
      basis,
      chargeType: itemLabour.unit === LABOUR_UNIT_PERCENT ? 'PERCENTAGE_ITEM' : 'AMOUNT_ITEM',
    };
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
 * lookup. `prefetched` is what prefetchPricingReads started. `rules` is the
 * pricing rules the asking build prices and bills with (pricingInputs
 * pricingRulesOf): 1, the default, for the builds already in shops. Throws:
 *   INVALID_PRICING_INPUT (400) for a body that cannot be priced, before
 *     anything is read;
 *   EMPLOYEE_NOT_FOUND (403) for an employee without a roster record;
 *   RATES_UNAVAILABLE (503) when there is no live gold rate to price on.
 */
async function computeMrp({ user, sessionContext, scanId, input, scan: knownScan = null, prefetched = null, rules = 1 }) {
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

  // With no scan record (one dropped from memory), the shop's scanner
  // setting, as the analysis chose it (deriveInputFromReading).
  const recordMode = scan
    ? scan.calculationMode
    : (liveRatesData?.taxSettings?.scannerCalculationUse === 'cash' ? 'cash' : null);
  let resolvedMode = request.calculationMode || recordMode || 'rtgs';

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
  // A build on rules 1 bills no wastage line for an item it did not name
  // exactly, so there the item is the one whose code is exactly the item
  // code sent, as it always was.
  const itemMatch = rules >= CURRENT_PRICING_RULES
    ? findItemOnTag(identifiers, itemRows)
    : findItemExactly(request.itemCode, itemRows);
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
    rules,
  });

  // The arithmetic itself: pricingMath.
  const priced = computePricing({
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
 * build that asked (`rules`, pricingInputs pricingRulesOf) builds its own
 * first request from the same reading (pricingPrefetch.derivePricingInput
 * after processing.tsx and the review card's stone rows), so the first price
 * and the card's agree:
 *   - weights, rates and other charges are the first figure in each field;
 *     a blank net weight stays 0 and pricingMath works it out from the
 *     gross weight;
 *   - the karat from the karat field, the purity (tunch) or a fineness;
 *   - diamond rates from the account's own table (or the shop's), a stone's
 *     packet code first, else its printed rate;
 *   - rules 2: stone weights in their printed unit; a colour stone's rate
 *     from its packet's row, else its colour and clarity's (non-packet) row,
 *     else its printed rate;
 *   - rules 1 (builds up to 1.0.366): stone weights in carats, which is all
 *     they send; a colour stone's rate from the first row with its colour
 *     and clarity, a miss clearing the printed rate, as those cards do;
 *   - the labour the card starts with (pricingInputs appLabourFields): the
 *     tag's, else (rules 2) the item's, else the shop's charge;
 *   - the item code and every identifier on the tag, for the Masters item
 *     and wastage code; the mode from the scan session.
 */
async function deriveInputFromReading({ user, structuredData, scan, prefetched = null, rules = 1 }) {
  const data = structuredData || {};
  const scope = settingsScope(user);
  const currentRules = rules >= CURRENT_PRICING_RULES;
  const serialNumber = stoneField(data, 'serialNumber');
  const tagIdentifiers = tagIdentifiersOf({
    structuredData: data,
    unknownFields: scan?.analysisResult?.unknownFields,
  });
  const identifiers = distinctIdentifiers([serialNumber, ...tagIdentifiers]);
  const [diamondRows, colorstoneRows, taxSettings, labourDoc, itemRows] = await Promise.all([
    prefetched?.diamondRows || findScopedRows(DiamondRate, scope),
    prefetched?.colorstoneRows || findScopedRows(ColorstoneRate, scope),
    prefetched?.taxSettings || findScopedSetting(GoldTaxSetting, scope),
    prefetched?.labour || findScopedSetting(LabourRate, scope),
    // Only the current app fills the labour box from the Masters item.
    currentRules && identifiers.length
      ? prefetched?.itemRows || findScopedRows(ItemCode, scope)
      : Promise.resolve([]),
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
        unit: currentRules ? unit : 'ct',
      };
    })
    .filter(Boolean);

  const colorstones = parseStoneList(data.colorstones)
    .map((stone) => {
      const { weight, unit } = stoneWeightOf(stone);
      if (weight <= 0) return null;
      const printedRate = readFigure(stoneField(stone, 'rate'));
      if (!currentRules) {
        const rate = legacyAppColorstoneRate(colorstoneRowsPlain, {
          color: stoneField(stone, 'color'),
          clarity: stoneField(stone, 'clarity'),
          printedRate,
        });
        return { weight, rate, unit: 'ct' };
      }
      const match = findColorstoneRateMatch(colorstoneRowsPlain, {
        packetCode: stoneField(stone, 'packetCode') || globalPacketCode,
        color: stoneField(stone, 'color'),
        clarity: stoneField(stone, 'clarity'),
      });
      return { weight, rate: match ? readFigure(match.rate) : printedRate, unit };
    })
    .filter(Boolean);

  const itemMatch = currentRules ? findItemOnTag(identifiers, plainRows(itemRows)) : null;
  const labourFields = appLabourFields({
    tagLabour: stoneField(data, 'labour'),
    itemRow: itemMatch?.row || null,
    labourDoc,
    rules,
  });

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
    tagIdentifiers,
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

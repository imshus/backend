const { sendSuccess } = require('../utils/apiResponse');
const rateCalculationService = require('../services/rateCalculation.service');
const redisService = require('../services/redis.service');
const LabourRate = require('../models/labourRate.model');
const Employee = require('../models/employee.model');
const { aggregateJewelleryMrp } = require('../services/pricingAggregation.service');
const { assertScanAccess, toSessionContext } = require('../utils/scanAccess');

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

const calculateMRP = async (req, res, next) => {
  try {
    const { scanId } = req.params;
    const { 
      jewelleryType,
      netWt, 
      purityKarat, 
      customPurityPercent,
      diamonds, 
      colorstones 
    } = req.body;
    
    const businessId = req.user.businessId;
    const sessionContext = toSessionContext(req.user);

    // These reads are independent. Running them together keeps the preview
    // calculation bounded by the slowest lookup instead of their combined
    // latency.
    const employeePromise = req.user?.role === 'EMP'
      ? Employee.findById(req.user.userId).select('permissions')
      : Promise.resolve(null);
    const [liveRatesData, globalLabour, scanResolution, employee] = await Promise.all([
      rateCalculationService.getLiveGoldRates(businessId),
      LabourRate.findOne({ businessId }),
      resolveScanForCalculation(scanId, sessionContext),
      employeePromise,
    ]);
    const { resolvedScanId, scan } = scanResolution;

    // 1. Fetch live gold rates and purity percentages for this business
    
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

    // Fetch global labour rate for this business
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

    const {
      labourChargeAmount,
      labourChargeUnit,
      labourWeightBasis,
      grossWt,
      otherCharges,
      calculationMode,
    } = req.body;

    // 2. Calculate Diamond Amount (line-by-line, discount-aware)
    const diamondLineItems = Array.isArray(diamonds)
      ? diamonds.map((dia, index) => {
          const wt = toNumber(dia.weight);
          const rate = toNumber(dia.rate);
          const discountPercent = Math.max(0, Math.min(100, toNumber(dia.discountPercent)));
          const baseAmount = wt * rate;
          const amount = baseAmount - baseAmount * (discountPercent / 100);
          return {
            index: index + 1,
            weight: wt,
            rate,
            discountPercent,
            amount,
          };
        })
      : [];
    const diamondAmount = diamondLineItems.reduce((sum, item) => sum + item.amount, 0);

    // 3. Calculate Colorstone Amount (line-by-line)
    const colorstoneLineItems = Array.isArray(colorstones)
      ? colorstones.map((cs, index) => {
          const wt = toNumber(cs.weight);
          const rate = toNumber(cs.rate);
          const amount = wt * rate;
          return {
            index: index + 1,
            weight: wt,
            rate,
            amount,
          };
        })
      : [];
    const colorstoneAmount = colorstoneLineItems.reduce((sum, item) => sum + item.amount, 0);

    // 4. Calculate Pure Weight, selected gold rate and Labour Charge
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

    if (req.user?.role === 'EMP') {
      if (!employee) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
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

    // 5. Calculate Gold Amount
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
    const purityAdjustedGoldRatePerGram =
      selected24kGoldRatePerGram * (effectivePurityPercent / 100);

    // Gold Amount formula (as required):
    // Gold Amount = Pure Weight × selected 24K RTGS/Cash live rate per gram
    const goldAmount = pureWeight * selected24kGoldRatePerGram;

    const otherChargesAmount = toNumber(otherCharges);

    // 6. Calculate Final MRP using a strict numeric aggregation helper
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

    const calculationAudit = {
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
    };
    console.info('[MRP_CALC_AUDIT]', JSON.stringify(calculationAudit));

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
      finalMRP
    };

    // Send the amount as soon as it is calculated. Persisting the calculation
    // is still awaited for reliability, but no longer delays the client UI.
    sendSuccess(res, resultData);

    // Store in Redis
    if (resolvedScanId && scan) {
      try {
        await redisService.updateScanStatus(resolvedScanId, scan.status, {
          calculation: resultData,
          calculationInputSnapshot: {
            jewelleryType,
            netWt: numericNetWt,
            grossWt: numericGrossWt,
            purityKarat,
            customPurityPercent: hasCustomPurityPercent ? effectivePurityPercent : null,
            diamonds,
            colorstones,
            otherCharges: otherChargesAmount,
            calculationMode: resolvedMode,
          },
          calculationMode: resolvedMode,
        });
      } catch (cacheError) {
        console.warn('[MRP_CALC_CACHE_WRITE_FAILED]', {
          scanId: resolvedScanId,
          message: cacheError.message,
        });
      }
    }
  } catch (error) {
    next(error);
  }
};

module.exports = {
  calculateMRP
};

const { sendSuccess } = require('../utils/apiResponse');
const redisService = require('../services/redis.service');
const { computeMrp } = require('../services/mrpCalculation.service');
const { pricingRulesOf } = require('../services/pricingInputs');
const { toSessionContext } = require('../utils/scanAccess');
const scanHistory = require('../services/scanHistory.service');

/**
 * POST /scans/:scanId/calculate — the price for the inputs the review card
 * holds right now. The arithmetic lives in mrpCalculation.service, shared
 * with the analysis, which prices a fresh reading the moment it lands.
 *
 * Priced by the rules the asking build bills with (X-Pricing-Rules: 3 from
 * the build that prices wastage at the current gold rate, 2 from 1.0.367;
 * none from the builds before it), so the MRP a card quotes is the one its
 * invoice bills.
 *
 * Every price it returns is also the scan's line in Tag scan history
 * (scanHistory.service), written after the answer has gone.
 */
const calculateMRP = async (req, res, next) => {
  try {
    const { scanId } = req.params;
    let computed;
    try {
      computed = await computeMrp({
        user: req.user,
        sessionContext: toSessionContext(req.user),
        scanId,
        input: req.body,
        rules: pricingRulesOf(req),
      });
    } catch (error) {
      // An employee with no roster record answers 403 inline, as it always
      // did; scan-access failures keep flowing to the error handler.
      if (error?.code === 'EMPLOYEE_NOT_FOUND') {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }
      // A body that cannot be priced (400, naming the field) and no live
      // rate to price on (503): said plainly, never a made-up price.
      if (error?.code === 'INVALID_PRICING_INPUT' || error?.code === 'RATES_UNAVAILABLE') {
        return res.status(error.statusCode).json({ success: false, error: error.code, message: error.message });
      }
      throw error;
    }
    const { resultData, resolvedScanId, scan, snapshot, resolvedMode, request, itemRow } = computed;

    // Send the amount as soon as it is calculated. Persisting the calculation
    // is still awaited for reliability, but no longer delays the client UI.
    sendSuccess(res, resultData);

    if (resolvedScanId && scan) {
      try {
        await redisService.updateScanStatus(resolvedScanId, scan.status, {
          calculation: resultData,
          calculationInputSnapshot: snapshot,
          calculationMode: resolvedMode,
        });
      } catch (cacheError) {
        console.warn('[MRP_CALC_CACHE_WRITE_FAILED]', {
          scanId: resolvedScanId,
          message: cacheError.message,
        });
      }
    }

    // The scan's line in Settings -> History, the latest price replacing
    // any earlier one. Filed under the scan that was priced: the requested
    // one, or the newer scan it resolved to. The price is already sent, and
    // a failure here only costs the history line.
    const historyScanId = resolvedScanId || scanId;
    try {
      await scanHistory.recordPricedScan({
        user: req.user,
        scanId: historyScanId,
        ...scanHistory.historyEntryOf({ request, itemRow, scan }),
        finalMRP: resultData.finalMRPRounded,
      });
    } catch (historyError) {
      console.warn('[SCAN_HISTORY_WRITE_FAILED]', {
        scanId: historyScanId,
        message: historyError.message,
      });
    }
  } catch (error) {
    next(error);
  }
};

module.exports = {
  calculateMRP
};

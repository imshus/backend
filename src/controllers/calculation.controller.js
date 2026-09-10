const { sendSuccess } = require('../utils/apiResponse');
const redisService = require('../services/redis.service');
const { computeMrp } = require('../services/mrpCalculation.service');
const { toSessionContext } = require('../utils/scanAccess');

/**
 * POST /scans/:scanId/calculate — the price for the inputs the review card
 * holds right now. The arithmetic lives in mrpCalculation.service, shared
 * with the analysis, which prices a fresh reading the moment it lands.
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
      });
    } catch (error) {
      // An employee with no roster record answers 403 inline, as it always
      // did; scan-access failures keep flowing to the error handler.
      if (error?.code === 'EMPLOYEE_NOT_FOUND') {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }
      throw error;
    }
    const { resultData, resolvedScanId, scan, snapshot, resolvedMode } = computed;

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
  } catch (error) {
    next(error);
  }
};

module.exports = {
  calculateMRP
};

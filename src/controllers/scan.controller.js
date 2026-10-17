const fs = require('fs');
const sharp = require('sharp');
const scanService = require('../services/scan.service');
const openaiService = require('../services/openai.service');
const {
  computeMrp,
  deriveInputFromReading,
  prefetchPricingReads,
} = require('../services/mrpCalculation.service');
const { pricingRulesOf } = require('../services/pricingInputs');
const { sendSuccess } = require('../utils/apiResponse');
const { toSessionContext } = require('../utils/scanAccess');
const { tagIdentifiersOf } = require('../utils/tagIdentifiers');
const { recordScanTiming } = require('../services/scanTiming');
const scanHistory = require('../services/scanHistory.service');

const createScan = async (req, res, next) => {
  try {
    const { jewelleryType, scanType } = req.body;
    const scanData = await scanService.createScan(jewelleryType, scanType, toSessionContext(req.user));
    sendSuccess(res, scanData);
  } catch (err) {
    next(err);
  }
};

const uploadFrontImage = async (req, res, next) => {
  try {
    const { scanId } = req.params;
    if (!req.file) throw new Error('Front image is required');

    console.info('[UPLOAD_RECEIVED]', {
      scanId,
      side: 'front',
      fileName: req.file.originalname,
      storedAs: req.file.filename,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
    });
    
    const updated = await scanService.saveImage(scanId, req.file.path, 'front', toSessionContext(req.user), {
      speculate: String(req.body?.speculate || '') === '1',
      businessId: req.user?.businessId,
    });
    sendSuccess(res, { scanId: updated.scanId, status: updated.status });
  } catch (err) {
    next(err);
  }
};

const uploadBackImage = async (req, res, next) => {
  try {
    const { scanId } = req.params;
    if (!req.file) throw new Error('Back image is required');

    console.info('[UPLOAD_RECEIVED]', {
      scanId,
      side: 'back',
      fileName: req.file.originalname,
      storedAs: req.file.filename,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
    });
    
    const updated = await scanService.saveImage(scanId, req.file.path, 'back', toSessionContext(req.user), {
      speculate: String(req.body?.speculate || '') === '1',
      businessId: req.user?.businessId,
    });
    sendSuccess(res, { scanId: updated.scanId, status: updated.status });
  } catch (err) {
    next(err);
  }
};

const analyzeScan = async (req, res, next) => {
  const receivedAt = Date.now();
  try {
    const { scanId } = req.params;
    console.info('[API_ANALYZE_REQUEST_RECEIVED]', {
      scanId,
      timestamp: Date.now(),
      businessId: String(req.user?.businessId || ''),
      userId: String(req.user?.userId || ''),
    });
    const scannerSettings = req.body?.scannerSettings || {};
    // The price's own reads run while the model reads the tag, instead of
    // after it, one round after another.
    const pricingReads = prefetchPricingReads(req.user);
    const updated = await scanService.analyzeScan(
      scanId,
      scannerSettings,
      req.user?.businessId,
      toSessionContext(req.user),
      req.licenseContext || null,
    );

    // Price the reading right here, so the review card opens with the MRP
    // beside the values instead of paying another round trip for it. Any
    // failure leaves pricing out; the card then prices itself as before.
    let pricing = null;
    let pricingInput = null;
    let computed = null;
    // Why there is no price, when the reason is one the card can say
    // (no live rate, a reading that cannot be priced); null otherwise.
    let pricingError = null;
    // The rules the asking build prices its card with, so the price made
    // here is the one its card asks for first.
    const rules = pricingRulesOf(req);
    const pricingStartedAt = Date.now();
    try {
      pricingInput = await deriveInputFromReading({
        user: req.user,
        structuredData: updated.analysisResult.structuredData,
        scan: updated,
        prefetched: pricingReads,
        rules,
      });
      computed = await computeMrp({
        user: req.user,
        sessionContext: toSessionContext(req.user),
        scanId: updated.scanId,
        input: pricingInput,
        scan: updated,
        prefetched: pricingReads,
        rules,
      });
      pricing = computed.resultData;
    } catch (error) {
      console.warn('[ANALYZE_PRICING_SKIPPED]', { scanId, message: error?.message });
      if (error?.code === 'RATES_UNAVAILABLE' || error?.code === 'INVALID_PRICING_INPUT') {
        pricingError = { code: error.code, message: error.message };
      }
    }
    const pricingMs = Date.now() - pricingStartedAt;

    // One timing line per analyzed scan (not for a finished scan asked
    // again, which carries none), and the window /api/v1/health reports.
    if (updated.timing) {
      recordScanTiming({
        ...updated.timing,
        scanId: updated.scanId,
        pricingMs,
        totalMs: Date.now() - receivedAt,
      });
    }

    sendSuccess(res, {
        scanId: updated.scanId,
        status: updated.status,
        provider: updated.analysisResult.provider,
        rawText: updated.analysisResult.rawText,
        structuredData: updated.analysisResult.structuredData,
        unknownFields: [], // Force empty to bypass frontend clarification screen
        // Every identifier the reader found, main one first, so the app can
        // match its Item Code master against an item code set aside (a tag
        // with SR NO and an item code was matched on the SR NO alone).
        tagIdentifiers: tagIdentifiersOf(updated.analysisResult),
        overallConfidence: updated.analysisResult.overallConfidence,
        billing: updated.billing || { billed: false },
        pricing,
        pricingInput,
        pricingError,
    });

    // The scan's line in Settings -> History starts here, the moment the tag
    // is read: everything read, and the price above when there is one. The
    // reading is already sent, and a failure here only costs the line.
    try {
      const itemRows = computed ? [] : await pricingReads.itemRows.catch(() => []);
      await scanHistory.recordReadScan({
        user: req.user,
        scanId: updated.scanId,
        ...scanHistory.readEntryOf({ scan: updated, computed, itemRows }),
      });
    } catch (historyError) {
      console.warn('[SCAN_HISTORY_READ_WRITE_FAILED]', {
        scanId: updated.scanId,
        message: historyError?.message,
      });
    }
  } catch (err) {
    next(err);
  }
};

const getClarification = async (req, res, next) => {
  try {
    const { scanId } = req.params;
    const data = await scanService.getClarification(scanId, toSessionContext(req.user));
    
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

const submitClarification = async (req, res, next) => {
  try {
    const { scanId } = req.params;
    const { confirmedMappings } = req.body;
    
    await scanService.submitClarification(scanId, confirmedMappings, toSessionContext(req.user));
    
    res.status(200).json({ status: "CLARIFICATION_COMPLETED" });
  } catch (err) {
    next(err);
  }
};

const getReview = async (req, res, next) => {
  try {
    const { scanId } = req.params;
    const data = await scanService.getReviewData(scanId, toSessionContext(req.user));
    
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

const submitReview = async (req, res, next) => {
  try {
    const { scanId } = req.params;
    const finalData = req.body;
    
    await scanService.submitReview(scanId, finalData, toSessionContext(req.user));
    
    res.status(200).json({ status: "APPROVED" });
  } catch (err) {
    next(err);
  }
};


/**
 * POST /scans/detect-tag — where the printed tag sits in an uploaded photo.
 *
 * The app frames a gallery photo before it becomes a scan; this saves the
 * user doing it by hand. One small model call, the file dropped straight
 * afterwards, and a failure answers "not found" rather than an error: the
 * framing is then simply left to the user.
 */
const detectTagArea = async (req, res, next) => {
  const filePath = req.file?.path;
  try {
    if (!filePath) throw new Error('Image is required');

    // Small: the box is wanted, not the characters.
    const jpeg = await sharp(filePath, { failOn: 'none' })
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    let box = null;
    try {
      box = await openaiService.detectTagBox(jpeg.toString('base64'), {
        businessId: req.user?.businessId,
        userId: req.user?.userId,
      });
    } catch (error) {
      console.warn('[TAG_BOX_FAILED]', { message: error?.message });
    }

    sendSuccess(res, { found: Boolean(box), box });
  } catch (err) {
    next(err);
  } finally {
    if (filePath) {
      fs.promises.unlink(filePath).catch(() => {});
    }
  }
};

module.exports = {
  createScan,
  detectTagArea,
  uploadFrontImage,
  uploadBackImage,
  analyzeScan,
  getClarification,
  submitClarification,
  getReview,
  submitReview
};

const fs = require('fs');
const sharp = require('sharp');
const scanService = require('../services/scan.service');
const openaiService = require('../services/openai.service');
const { computeMrp, deriveInputFromReading } = require('../services/mrpCalculation.service');
const { sendSuccess } = require('../utils/apiResponse');
const { toSessionContext } = require('../utils/scanAccess');

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
  try {
    const { scanId } = req.params;
    console.info('[API_ANALYZE_REQUEST_RECEIVED]', {
      scanId,
      timestamp: Date.now(),
      businessId: String(req.user?.businessId || ''),
      userId: String(req.user?.id || req.user?._id || ''),
    });
    const scannerSettings = req.body?.scannerSettings || {};
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
    try {
      pricingInput = await deriveInputFromReading({
        user: req.user,
        structuredData: updated.analysisResult.structuredData,
        scan: updated,
      });
      const computed = await computeMrp({
        user: req.user,
        sessionContext: toSessionContext(req.user),
        scanId: updated.scanId,
        input: pricingInput,
        scan: updated,
      });
      pricing = computed.resultData;
    } catch (pricingError) {
      console.warn('[ANALYZE_PRICING_SKIPPED]', { scanId, message: pricingError?.message });
    }

    sendSuccess(res, {
        scanId: updated.scanId,
        status: updated.status,
        provider: updated.analysisResult.provider,
        rawText: updated.analysisResult.rawText,
        structuredData: updated.analysisResult.structuredData,
        unknownFields: [], // Force empty to bypass frontend clarification screen
        overallConfidence: updated.analysisResult.overallConfidence,
        billing: updated.billing || { billed: false },
        pricing,
        pricingInput,
    });
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

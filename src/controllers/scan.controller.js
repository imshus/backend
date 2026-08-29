const scanService = require('../services/scan.service');
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
    
    const updated = await scanService.saveImage(scanId, req.file.path, 'front', toSessionContext(req.user));
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
    
    const updated = await scanService.saveImage(scanId, req.file.path, 'back', toSessionContext(req.user));
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
    
    sendSuccess(res, {
        scanId: updated.scanId,
        status: updated.status,
        provider: updated.analysisResult.provider,
        rawText: updated.analysisResult.rawText,
        structuredData: updated.analysisResult.structuredData,
        unknownFields: [], // Force empty to bypass frontend clarification screen
        overallConfidence: updated.analysisResult.overallConfidence,
        billing: updated.billing || { billed: false }
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

module.exports = {
  createScan,
  uploadFrontImage,
  uploadBackImage,
  analyzeScan,
  getClarification,
  submitClarification,
  getReview,
  submitReview
};

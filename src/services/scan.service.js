const { randomUUID: uuidv4 } = require('crypto');
const redisService = require('./redis.service');
const openaiService = require('./openai.service');
const ocrPreprocessCache = require('./ocrPreprocess.cache');
const scanBillingService = require('./scanBilling.service');
const fs = require('fs');
const { assertScanAccess } = require('../utils/scanAccess');

async function cleanupTempImage(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
    console.info('[UPLOAD_TEMP_CLEANUP]', { filePath, deleted: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[UPLOAD_TEMP_CLEANUP_FAILED]', { filePath, error: error.message });
    }
  }
}

const createScan = async (jewelleryType, scanType, session = {}) => {
  if (session?.businessId && session?.userId) {
    const previousScanId = await redisService.getLatestScanIdForUser(
      session.businessId,
      session.userId,
    );
    if (previousScanId) {
      // Do NOT hard-delete old scans here.
      // In development/strict-mode UI flows, multiple create-scan calls can happen,
      // and deleting the prior scan can break in-flight calls with "Scan not found".
      // Instead, mark the previous scan as superseded and clear volatile calc data.
      try {
        await redisService.updateScanStatus(previousScanId, 'SUPERSEDED', {
          calculation: null,
          calculationInputSnapshot: null,
        });
      } catch (error) {
        // If previous scan does not exist, continue with new scan creation.
      }
    }
  }

  const scanId = uuidv4();
  const scanData = {
    scanId,
    status: 'WAITING_FOR_SCAN',
    jewelleryType,
    scanType,
    ownerUserId: session.userId || null,
    businessId: session.businessId || null,
    createdAt: new Date().toISOString()
  };
  await redisService.setScan(scanId, scanData);
  if (session?.businessId && session?.userId) {
    await redisService.setLatestScanIdForUser(session.businessId, session.userId, scanId);
  }
  console.info('[SCAN_OPERATION_CREATED]', {
    scanId,
    businessId: String(session.businessId || ''),
    userId: String(session.userId || ''),
    jewelleryType,
    scanType,
  });
  return scanData;
};

/**
 * Speculative analysis.
 *
 * A scan's wait is the model call, and it used to start only when the user
 * tapped Calculate, after they had already looked at the preview for a second
 * or three. With the client's consent (a `speculate` field on the upload) the
 * call now starts shortly after an image lands, keyed to the exact image set
 * it saw. The analyze request collects that result when the set still
 * matches, and runs fresh otherwise. Nothing is written to the scan and no
 * credit is billed until the analyze request arrives, so an abandoned preview
 * costs a model call and nothing else.
 *
 * The short settle delay lets a re-crop (a new upload for the same side)
 * replace the first image before any call is made for it.
 */
const SPECULATIVE_ANALYSIS_ENABLED = String(process.env.SPECULATIVE_ANALYSIS || 'true').toLowerCase() !== 'false';
const SPECULATIVE_SETTLE_MS = Number(process.env.SPECULATIVE_SETTLE_MS) || 1200;
const SPECULATIVE_MAX_AGE_MS = 10 * 60 * 1000;
const speculativeAnalyses = new Map();

const imageSetKey = (scan, scannerSettings = {}) =>
  `${scan.frontImagePath || ''}|${scan.backImagePath || ''}|${JSON.stringify(scannerSettings || {})}`;

const dropSpeculative = (scanId) => {
  const entry = speculativeAnalyses.get(scanId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  speculativeAnalyses.delete(scanId);
};

const pruneSpeculative = () => {
  const now = Date.now();
  for (const [scanId, entry] of speculativeAnalyses) {
    if (now - entry.createdAt > SPECULATIVE_MAX_AGE_MS) dropSpeculative(scanId);
  }
};

const runModelForScan = async (scan, scannerSettings, businessId) => {
  const { frontImagePath, backImagePath, jewelleryType, scanType } = scan;
  let frontPreprocessedBase64 = null;
  let backPreprocessedBase64 = null;
  try {
    const frontPromise = ocrPreprocessCache.takePreprocessed(scan.scanId, 'front', frontImagePath);
    if (frontPromise) frontPreprocessedBase64 = await frontPromise;
  } catch (error) {
    frontPreprocessedBase64 = null;
  }
  try {
    const backPromise = ocrPreprocessCache.takePreprocessed(scan.scanId, 'back', backImagePath);
    if (backPromise) backPreprocessedBase64 = await backPromise;
  } catch (error) {
    backPreprocessedBase64 = null;
  }
  return openaiService.analyzeImages(
    frontImagePath,
    backImagePath,
    jewelleryType,
    scanType,
    scannerSettings,
    businessId,
    { frontBase64: frontPreprocessedBase64, backBase64: backPreprocessedBase64 },
  );
};

const scheduleSpeculativeAnalysis = (scan, businessId) => {
  if (!SPECULATIVE_ANALYSIS_ENABLED || !scan?.scanId) return;
  if (!scan.frontImagePath && !scan.backImagePath) return;
  pruneSpeculative();
  dropSpeculative(scan.scanId);
  const key = imageSetKey(scan, {});
  const entry = { key, promise: null, timer: null, createdAt: Date.now() };
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (speculativeAnalyses.get(scan.scanId) !== entry) return;
    console.info('[SPECULATIVE_ANALYSIS_START]', { scanId: scan.scanId });
    entry.promise = runModelForScan(scan, {}, businessId);
    entry.promise.catch((error) => {
      console.warn('[SPECULATIVE_ANALYSIS_FAILED]', {
        scanId: scan.scanId,
        error: error?.message || String(error),
      });
    });
  }, SPECULATIVE_SETTLE_MS);
  speculativeAnalyses.set(scan.scanId, entry);
};

/** The speculative result for this exact image set, or null to run fresh. */
const takeSpeculativeResult = async (scanId, scan, scannerSettings) => {
  const entry = speculativeAnalyses.get(scanId);
  if (!entry) return null;
  dropSpeculative(scanId);
  if (entry.key !== imageSetKey(scan, scannerSettings) || !entry.promise) {
    return null;
  }
  try {
    const result = await entry.promise;
    console.info('[SPECULATIVE_ANALYSIS_USED]', { scanId });
    return result;
  } catch (error) {
    return null;
  }
};

const saveImage = async (scanId, imagePath, type, session = {}, options = {}) => {
  const statusMap = {
    front: 'FRONT_IMAGE_RECEIVED',
    back: 'BACK_IMAGE_RECEIVED'
  };
  const scan = await redisService.getScan(scanId);
  assertScanAccess(scan, session);
  console.info('[IMAGE_UPLOAD_START]', { scanId, side: type });
  const updated = await redisService.updateScanStatus(scanId, statusMap[type], {
    [`${type}ImagePath`]: imagePath
  });
  // Fire-and-forget: start OCR preprocessing now so /analyze can reuse the result.
  ocrPreprocessCache.warmPreprocess(scanId, type, imagePath);
  // A new image invalidates any call made for the old set; start one for the
  // new set if the client asked for it.
  dropSpeculative(scanId);
  if (options.speculate) {
    scheduleSpeculativeAnalysis(updated, options.businessId);
  }
  console.info('[IMAGE_UPLOAD_COMPLETE]', {
    scanId,
    side: type,
    timestamp: Date.now(),
  });
  return updated;
};

const analyzeScan = async (scanId, scannerSettings = {}, businessId, session = {}, licenseContext = null) => {
  const scan = await redisService.getScan(scanId);
  assertScanAccess(scan, session);

  const { frontImagePath, backImagePath, jewelleryType, scanType } = scan;
  if (!frontImagePath && !backImagePath) {
    throw new Error('No images uploaded for this scan');
  }

  const startedAt = Date.now();
  console.info('[OPENAI_REQUEST_START]', {
    scanId,
    timestamp: Date.now(),
  });
  console.info('[OPENAI_ANALYSIS_START]', {
    scanId,
    hasFrontImage: Boolean(frontImagePath),
    hasBackImage: Boolean(backImagePath),
  });
  // Reuse upload-time preprocessed images when available; entries only match
  // the exact file path of this scan's stored upload, and any failure here
  // degrades to the on-demand preprocessing inside analyzeImages.
  let frontPreprocessedBase64 = null;
  let backPreprocessedBase64 = null;
  try {
    const frontPromise = ocrPreprocessCache.takePreprocessed(scanId, 'front', frontImagePath);
    if (frontPromise) frontPreprocessedBase64 = await frontPromise;
  } catch (error) {
    frontPreprocessedBase64 = null;
  }
  try {
    const backPromise = ocrPreprocessCache.takePreprocessed(scanId, 'back', backImagePath);
    if (backPromise) backPreprocessedBase64 = await backPromise;
  } catch (error) {
    backPreprocessedBase64 = null;
  }

  // Call OpenAI to get structured data
  let result = await takeSpeculativeResult(scanId, scan, scannerSettings);
  try {
    if (!result) result = await openaiService.analyzeImages(
      frontImagePath,
      backImagePath,
      jewelleryType,
      scanType,
      scannerSettings,
      businessId,
      {
        frontBase64: frontPreprocessedBase64,
        backBase64: backPreprocessedBase64,
      },
    );
  } catch (error) {
    console.error('[OCR_ANALYSIS_FAILED]', {
      scanId,
      durationMs: Date.now() - startedAt,
      error: error?.message || String(error),
    });
    // Keep the Redis record and temp images intact so POST /analyze can be retried.
    try {
      await redisService.updateScanStatus(scanId, 'ANALYSIS_FAILED', {
        analysisError: error?.message || String(error),
      });
    } catch (statusError) {
      console.error('[SCAN_STATUS_UPDATE_FAILED]', {
        scanId,
        targetStatus: 'ANALYSIS_FAILED',
        error: statusError?.message || String(statusError),
      });
    }
    throw new Error('OCR_IMAGE_PROCESSING_FAILED');
  }

  console.info('[OCR_ANALYSIS_COMPLETE]', {
    scanId,
    durationMs: Date.now() - startedAt,
    hasFrontImage: Boolean(frontImagePath),
    hasBackImage: Boolean(backImagePath),
    provider: result?.provider || 'openai',
    hasError: Boolean(result?.error),
  });
  console.info('[OPENAI_RESPONSE_RECEIVED]', {
    scanId,
    timestamp: Date.now(),
    durationMs: Date.now() - startedAt,
  });

  // A scan becomes financially complete only after OCR/AI analysis returns a usable result.
  // Opening the scanner, capturing, or uploading an image is intentionally not billable.
  console.info('[SCAN_COMPLETE]', { scanId, businessId: String(scan.businessId || '') });

  // STEP 1 — respond with the calculation immediately. Access (license + credit
  // balance) was already enforced by requireScannerAccess middleware before this
  // request reached analyze, so billing does not need to block the user.
  const updated = await redisService.updateScanStatus(scanId, 'ANALYSIS_COMPLETED', {
    analysisResult: result,
    billing: { billed: false, pending: true },
  });

  // STEP 2 — bill and clean up in the background. billCompletedScan is
  // idempotent (unique scanId row), so retries after a crash cannot
  // double-charge. Temp images are deleted only after a fully successful
  // analysis (failures above keep them for retry) — fire-and-forget so the
  // response is not blocked on disk I/O.
  setImmediate(() => {
    cleanupTempImage(frontImagePath);
    cleanupTempImage(backImagePath);
    finalizeBillingInBackground({ scan, analysisResult: result, session, licenseContext });
  });

  return updated;
};

async function finalizeBillingInBackground({ scan, analysisResult, session, licenseContext }) {
  const scanId = scan.scanId;
  try {
    const billingResult = await scanBillingService.billCompletedScan({
      scan,
      analysisResult,
      session,
      precomputedOverview: licenseContext,
    });
    await redisService.updateScanStatus(scanId, 'ANALYSIS_COMPLETED', {
      billing: billingResult
        ? {
            billed: true,
            pending: false,
            totalScanCharge: Number(billingResult.totalScanCharge || 0),
            billedAt: billingResult.billedAt || billingResult.createdAt || new Date(),
          }
        : { billed: false, pending: false },
    });
    console.info('[BILLING_BACKGROUND_COMPLETE]', {
      scanId,
      totalScanCharge: Number(billingResult?.totalScanCharge || 0),
    });
  } catch (error) {
    console.error('[BILLING_ERROR]', {
      scanId,
      stage: 'backgroundBilling',
      error: error?.message || String(error),
    });
    try {
      await redisService.updateScanStatus(scanId, 'BILLING_FAILED', {
        billingError: error?.message || String(error),
        billing: { billed: false, pending: false, error: error?.message || String(error) },
      });
    } catch (statusError) {
      console.error('[SCAN_STATUS_UPDATE_FAILED]', {
        scanId,
        targetStatus: 'BILLING_FAILED',
        error: statusError?.message || String(statusError),
      });
    }
  }
}

const getAvailableFieldsForJewelleryType = (jewelleryType) => {
  const common = ['grossWeight', 'netWeight', 'purity', 'labour', 'other'];

  const stoneFieldsByType = {
    DIAMOND: ['diamondWeight', 'diamondRate', 'diamondQuality', 'diamondPieces'],
    GOLD: ['goldWeight', 'goldRate', 'goldQuality', 'goldPieces'],
    SILVER: ['silverWeight', 'silverRate', 'silverQuality', 'silverPieces'],
    COLOUR_STONE: [
      'coloredStoneWeight',
      'coloredStoneRate',
      'coloredStoneQuality',
      'coloredStonePieces',
    ],
  };

  const stoneFields = stoneFieldsByType[jewelleryType] || stoneFieldsByType.DIAMOND;
  return [...common, ...stoneFields];
};

const getClarification = async (scanId, session = {}) => {
  const scan = await redisService.getScan(scanId);
  assertScanAccess(scan, session);
  if (!scan.analysisResult) throw new Error('Scan analysis not found');

  const fieldsNeedingReview = [];
  
  const defaultAvailableFields = getAvailableFieldsForJewelleryType(scan.jewelleryType || 'DIAMOND');

  const unknownFields = scan.analysisResult.unknownFields || [];
  const structuredData = scan.analysisResult.structuredData || {};
  
  const extractedValues = new Set();
  for (const field of Object.values(structuredData)) {
      if (field.value) {
          const val = field.value.toString().trim().toLowerCase();
          extractedValues.add(val);
          const match = val.match(/^(\d+(\.\d+)?)/);
          if (match) {
              extractedValues.add(match[1]);
          }
      }
  }

  const isIdentifier = (val, abbr, suggested) => {
      if (/identifier|product id|barcode|code/i.test(abbr) || /identifier|product id|barcode|code/i.test(suggested)) return true;
      if (val) {
          if (/^[A-Z0-9]{7,}$/i.test(val)) return true; // e.g. GR01496B, 25LDGR272483929
          if (/^\d{4,}$/.test(val)) return true; // e.g. 1671
          if (abbr === 'Unidentified' && val.length === 1 && /[a-zA-Z]/i.test(val)) return true; // e.g. 'g'
      }
      return false;
  };

  for (const uf of unknownFields) {
    const abbr = (uf.abbreviation || "").trim();
    const val = (uf.detectedValue || "").trim();
    const suggested = (uf.suggestedMeaning || "").trim();
    
    // 4. Empty abbreviations are not allowed.
    if (!abbr) continue;
    
    // 1 & 2. Ignore Product IDs, Barcodes, Item codes, Random numbers
    if (isIdentifier(val, abbr, suggested)) continue;
    
    // Ignore values already extracted with high confidence
    if (val && extractedValues.has(val.toLowerCase())) continue;
    
    // Handle split numbers (e.g. "10 14") where all parts are already extracted
    if (abbr === 'Unidentified' && val) {
        const parts = val.split(/\s+/);
        const allPartsExtracted = parts.length > 0 && parts.every(p => extractedValues.has(p.toLowerCase()));
        if (allPartsExtracted) continue;
    }

    // 3. suggestedField must contain a valid field key from availableFields
    let mappedSuggestedField = "other";
    if (suggested) {
        const exactMatch = defaultAvailableFields.find(af => af.toLowerCase() === suggested.toLowerCase());
        if (exactMatch) {
            mappedSuggestedField = exactMatch;
        } else {
            const partialMatch = defaultAvailableFields.find(af => suggested.toLowerCase().includes(af.toLowerCase()));
            if (partialMatch) mappedSuggestedField = partialMatch;
        }
    }

    fieldsNeedingReview.push({
      abbreviation: abbr,
      detectedValue: val,
      suggestedField: mappedSuggestedField,
      confidence: uf.confidence || 0,
      availableFields: defaultAvailableFields
    });
  }
  
  // added structuredData fields that have low confidence
  for (const [key, field] of Object.entries(structuredData)) {
    if (field.confidence < 80 && field.value) {
      const exists = fieldsNeedingReview.find(f => f.abbreviation === key);
      if (!exists) {
          fieldsNeedingReview.push({
             abbreviation: key,
             detectedValue: field.value,
             suggestedField: defaultAvailableFields.includes(key) ? key : "other",
             confidence: field.confidence,
             availableFields: defaultAvailableFields
          });
      }
    }
  }

  return {
    scanId,
    fieldsNeedingReview
  };
};

const applyClarificationMappings = (analysisResult, confirmedMappings) => {
  if (!analysisResult || !Array.isArray(confirmedMappings)) {
    return analysisResult;
  }

  const structuredData = { ...(analysisResult.structuredData || {}) };
  const unknownFields = analysisResult.unknownFields || [];

  for (const mapping of confirmedMappings) {
    if (!mapping?.mappedField || mapping.mappedField === 'other') {
      continue;
    }

    const unknown = unknownFields.find((uf) => uf.abbreviation === mapping.abbreviation);
    const detectedValue = (unknown?.detectedValue || '').trim();
    if (!detectedValue) {
      continue;
    }

    structuredData[mapping.mappedField] = {
      value: detectedValue,
      confidence: 100,
    };
  }

  return {
    ...analysisResult,
    structuredData,
  };
};

const submitClarification = async (scanId, confirmedMappings, session = {}) => {
  const scan = await redisService.getScan(scanId);
  assertScanAccess(scan, session);
  if (!scan.analysisResult) {
    throw new Error('Scan analysis not found');
  }

  const updatedAnalysis = applyClarificationMappings(scan.analysisResult, confirmedMappings);

  await redisService.updateScanStatus(scanId, 'CLARIFICATION_COMPLETED', {
    clarifications: confirmedMappings,
    analysisResult: updatedAnalysis,
  });
};

const getReviewData = async (scanId, session = {}) => {
  const scan = await redisService.getScan(scanId);
  assertScanAccess(scan, session);

   const structuredData = {};
   const rawStruct = scan.analysisResult?.structuredData || {};
   for (const [k, v] of Object.entries(rawStruct)) {
     if (Array.isArray(v)) {
       structuredData[k] = v;
     } else {
       const value = v?.value;
       if (value != null && String(value).trim() !== '') {
         structuredData[k] = String(value);
       }
     }
   }

    const normalizeKarat = (value) => {
      if (!value) return '';
      const valid = new Set(['24', '22', '20', '18', '14', '9']);
      const raw = String(value).trim();
      const withUnit = raw.match(/(\d+)\s*k(?:t)?/i);
      if (withUnit && valid.has(withUnit[1])) {
        return `${withUnit[1]}K`.toUpperCase();
      }

      const digitsOnly = raw.replace(/[^0-9]/g, '');
      if (valid.has(digitsOnly) && digitsOnly.length <= 2) {
        return `${digitsOnly}K`;
      }

      return '';
    };

    let resolvedKarat = normalizeKarat(structuredData.karat);
    if (!resolvedKarat) {
      resolvedKarat = normalizeKarat(structuredData.purity);
    }
    if (!resolvedKarat) {
      console.debug('Karat not detected from OCR/OpenAI response. Defaulted to 14K.');
      resolvedKarat = '14K';
    }
    structuredData.karat = resolvedKarat;

   const updated = await redisService.updateScanStatus(scanId, 'READY_FOR_REVIEW', {
       finalData: structuredData
   });

   return {
       scanId,
       status: updated.status,
       structuredData
   };
};

const submitReview = async (scanId, finalData, session = {}) => {
  const scan = await redisService.getScan(scanId);
  assertScanAccess(scan, session);
    await redisService.updateScanStatus(scanId, 'APPROVED', {
        finalData
    });
};

module.exports = {
  createScan,
  saveImage,
  analyzeScan,
  getClarification,
  submitClarification,
  getReviewData,
  submitReview
};

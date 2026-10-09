const { randomUUID: uuidv4 } = require('crypto');
const redisService = require('./redis.service');
const { settingsScope } = require('./userScope.service');
const openaiService = require('./openai.service');
const { getUserPrompt } = require('../prompts/openai.prompt');
const ocrPreprocessCache = require('./ocrPreprocess.cache');
const scanBillingService = require('./scanBilling.service');
const fs = require('fs');
const { assertScanAccess } = require('../utils/scanAccess');
const { isAbortError, throwIfAborted } = require('../utils/abort');

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
 *
 * A pipeline a newer upload supersedes (or that the analyze request cannot
 * use) is aborted, not just forgotten: its model calls are cancelled, and it
 * writes nothing, bills nothing and logs no failure.
 */
const SPECULATIVE_ANALYSIS_ENABLED = String(process.env.SPECULATIVE_ANALYSIS || 'true').toLowerCase() !== 'false';
const SPECULATIVE_SETTLE_MS = Number(process.env.SPECULATIVE_SETTLE_MS) || 1200;
const SPECULATIVE_MAX_AGE_MS = 10 * 60 * 1000;
const speculativeAnalyses = new Map();

// What the model's answer depends on: the image files and the prompt text
// the scan's settings produce. The speculative call runs before the app has
// sent its settings, and keying on the whole settings object made any
// setting at all — even one the prompt never reads — throw that answer away
// and pay for a fresh call on the user's wait. The labour setting is left out
// because it is a formatting rule, applied to the result on the way out.
const imageSetKey = (scan, scannerSettings = {}) => {
  const { labourChargePreference, ...promptSettings } = scannerSettings || {};
  const prompt = getUserPrompt(scan.jewelleryType, scan.scanType, promptSettings);
  return `${scan.frontImagePath || ''}|${scan.backImagePath || ''}|${prompt}`;
};

/**
 * Stops an entry for good: its timer, and its model calls if they started.
 * Only a pipeline still in flight is logged as cancelled; one that had already
 * finished (its calls made and paid for) is logged as discarded, so the logs
 * do not count savings that never happened.
 */
const cancelSpeculative = (entry) => {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.controller.signal.aborted) return;
  entry.controller.abort();
  if (!entry.promise) return;
  console.info(entry.done ? '[SPECULATIVE_ANALYSIS_DISCARDED]' : '[SPECULATIVE_ANALYSIS_CANCELLED]', {
    scanId: entry.scanId,
  });
};

const dropSpeculative = (scanId) => {
  const entry = speculativeAnalyses.get(scanId);
  if (!entry) return;
  speculativeAnalyses.delete(scanId);
  cancelSpeculative(entry);
};

const pruneSpeculative = () => {
  const now = Date.now();
  for (const [scanId, entry] of speculativeAnalyses) {
    if (now - entry.createdAt > SPECULATIVE_MAX_AGE_MS) dropSpeculative(scanId);
  }
};

const runModelForScan = async (scan, scannerSettings, scope, signal) => {
  const { frontImagePath, backImagePath, jewelleryType, scanType } = scan;
  const views = await takePreparedViews(scan.scanId, frontImagePath, backImagePath);
  throwIfAborted(signal);
  return openaiService.analyzeImages(
    frontImagePath,
    backImagePath,
    jewelleryType,
    scanType,
    scannerSettings,
    scope,
    views,
    { signal },
  );
};

/**
 * Image views prepared at upload time for this scan's exact files, or null
 * per side; any failure degrades to on-demand preparation inside analyzeImages.
 */
const takePreparedViews = async (scanId, frontImagePath, backImagePath) => {
  const take = async (side, filePath) => {
    try {
      const promise = ocrPreprocessCache.takePreprocessed(scanId, side, filePath);
      return promise ? await promise : null;
    } catch (error) {
      return null;
    }
  };
  const [frontViews, backViews] = await Promise.all([
    take('front', frontImagePath),
    take('back', backImagePath),
  ]);
  return { frontViews, backViews };
};

/** Starts an installed entry once its settle delay has passed; idempotent. */
const startSpeculative = (entry) => {
  if (!entry.settled || !entry.scan || entry.promise) return;
  if (entry.controller.signal.aborted || speculativeAnalyses.get(entry.scanId) !== entry) return;
  console.info('[SPECULATIVE_ANALYSIS_START]', {
    scanId: entry.scanId,
    businessId: String(entry.scope?.businessId || ''),
    userId: String(entry.scope?.userId || ''),
  });
  entry.promise = runModelForScan(entry.scan, {}, entry.scope, entry.controller.signal);
  entry.promise.then(
    () => {
      entry.done = true;
    },
    (error) => {
      entry.done = true;
      // Cancelled on purpose: superseded, not failed.
      if (isAbortError(error)) return;
      console.warn('[SPECULATIVE_ANALYSIS_FAILED]', {
        scanId: entry.scanId,
        error: error?.message || String(error),
      });
    },
  );
};

/**
 * A speculative analysis for an upload whose access check is still running.
 * The settle delay starts now, with the upload on disk; nothing can call the
 * model until install() publishes the entry with the updated scan, which
 * saveImage does only after the upload passed its access check and was
 * recorded. discard() drops an upload that did not.
 */
const beginSpeculativeAnalysis = (scanId, scope) => {
  if (!SPECULATIVE_ANALYSIS_ENABLED || !scanId) return null;
  const entry = {
    scanId,
    scope,
    key: null,
    scan: null,
    promise: null,
    // Set once the promise has settled (resolved or rejected).
    done: false,
    timer: null,
    settled: false,
    createdAt: Date.now(),
    controller: new AbortController(),
  };
  entry.timer = setTimeout(() => {
    entry.timer = null;
    entry.settled = true;
    startSpeculative(entry);
  }, SPECULATIVE_SETTLE_MS);
  return {
    install(scan) {
      if (entry.controller.signal.aborted) return;
      if (!scan?.frontImagePath && !scan?.backImagePath) {
        cancelSpeculative(entry);
        return;
      }
      entry.scan = scan;
      entry.key = imageSetKey(scan, {});
      pruneSpeculative();
      dropSpeculative(scanId);
      speculativeAnalyses.set(scanId, entry);
      // Starts right away when the record took longer than the settle delay.
      startSpeculative(entry);
    },
    discard() {
      cancelSpeculative(entry);
    },
  };
};

/** The speculative result for this exact image set, or null to run fresh. */
const takeSpeculativeResult = async (scanId, scan, scannerSettings) => {
  const entry = speculativeAnalyses.get(scanId);
  if (!entry) return null;
  // Claimed: out of the map, so no later upload can cancel what this request
  // is about to wait on.
  speculativeAnalyses.delete(scanId);
  if (
    entry.key !== imageSetKey(scan, scannerSettings) ||
    !entry.promise ||
    entry.controller.signal.aborted
  ) {
    // Not for these images and this prompt (or not started yet): cancel it,
    // run fresh. Whether the pipeline sent one read or two follows from the
    // images alone (a part cut or not), so a matching key covers that too.
    cancelSpeculative(entry);
    return null;
  }
  try {
    const result = await entry.promise;
    if (entry.controller.signal.aborted) return null;
    // Read without the app's labour setting; a labour the setting cannot be
    // applied to by rule is read again with the setting in the prompt.
    if (!openaiService.applyLabourPreference(result, scannerSettings)) {
      console.info('[SPECULATIVE_ANALYSIS_SKIPPED]', { scanId, reason: 'labour setting' });
      return null;
    }
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
  // The decode, the orientation call and the speculation's settle delay
  // start now, with the file on disk, instead of after the two scan-record
  // round trips below. Nothing they produce is visible until the upload has
  // passed its access check and been recorded; an upload that fails either
  // has its warm-up aborted and discarded unseen.
  const warmContext = (businessId) => ({
    businessId: session?.businessId || businessId || null,
    userId: session?.userId || null,
  });
  // Routes always carry the caller's business; a caller without one waits
  // for the scan's own, as before.
  let warm = session?.businessId
    ? ocrPreprocessCache.beginWarm(scanId, type, imagePath, warmContext(null))
    : null;
  const speculation = options.speculate
    ? beginSpeculativeAnalysis(
        scanId,
        settingsScope({ ...session, businessId: options.businessId || session.businessId }),
      )
    : null;

  let updated;
  try {
    const scan = await redisService.getScan(scanId);
    assertScanAccess(scan, session);
    if (!warm) {
      warm = ocrPreprocessCache.beginWarm(scanId, type, imagePath, warmContext(scan?.businessId));
    }
    console.info('[IMAGE_UPLOAD_START]', { scanId, side: type });
    updated = await redisService.updateScanStatus(scanId, statusMap[type], {
      [`${type}ImagePath`]: imagePath
    });
  } catch (error) {
    warm?.discard();
    speculation?.discard();
    throw error;
  }
  // The upload is the caller's and is recorded: /analyze can reuse the views.
  warm.commit();
  // A new image invalidates any call made for the old set; start one for the
  // new set if the client asked for it.
  dropSpeculative(scanId);
  speculation?.install(updated);
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

  // A finished scan answers with what it already found. Its temp images were
  // deleted on completion, so running the model again would read nothing and
  // overwrite a real result with values invented from the prompt — and bill a
  // second time for it.
  if (scan.status === 'ANALYSIS_COMPLETED' && scan.analysisResult) {
    console.info('[ANALYZE_ALREADY_COMPLETED]', { scanId });
    return scan;
  }

  // The stored paths must still be on disk before anything runs. A file can
  // vanish under a scan — a redeploy that replaces the uploads folder is the
  // known way — and reading it raw surfaced ENOENT with a server path on the
  // shop's screen. Refuse with something a person can act on instead.
  for (const [side, imagePath] of [['front', frontImagePath], ['back', backImagePath]]) {
    if (imagePath && !fs.existsSync(imagePath)) {
      console.error('[SCAN_IMAGE_MISSING]', { scanId, side, imagePath });
      throw new Error('SCAN_IMAGES_MISSING');
    }
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
  // Reuse upload-time image views when available; entries only match the
  // exact file path of this scan's stored upload.
  const views = await takePreparedViews(scanId, frontImagePath, backImagePath);

  // Call OpenAI to get structured data
  let result = await takeSpeculativeResult(scanId, scan, scannerSettings);
  try {
    if (!result) result = await openaiService.analyzeImages(
      frontImagePath,
      backImagePath,
      jewelleryType,
      scanType,
      scannerSettings,
      settingsScope({ ...session, businessId: session.businessId || businessId }),
      views,
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
    ocrPreprocessCache.releaseScan(scanId);
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

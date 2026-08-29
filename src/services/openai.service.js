const OpenAI = require('openai');
const { Agent, fetch: undiciFetch } = require('undici');
const sharp = require('sharp');
const config = require('../config/env');
const fs = require('fs');
const { getSystemPrompt, getUserPrompt } = require('../prompts/openai.prompt');
const { getPromptCustomizations } = require('./redis.service');
const DiamondRate = require('../models/diamondRate.model');
const ColorstoneRate = require('../models/colorstoneRate.model');

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
  timeout: 60_000,
  maxRetries: 1,
  // Keep-alive dispatcher: reuse warm TLS connections to api.openai.com so
  // each scan skips DNS + TCP + TLS handshakes. IMPORTANT: the dispatcher and
  // the fetch implementation must come from the SAME undici copy — passing an
  // undici@8 Agent into Node's built-in fetch (bundled undici) is rejected.
  fetch: undiciFetch,
  fetchOptions: {
    dispatcher: new Agent({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
      connections: 16,
    }),
  },
});

const DEFAULT_DIAMOND_COLORS = new Set([
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'EF',
  'FG',
  'GH',
  'HI',
  'IJ',
]);
const DEFAULT_DIAMOND_CLARITIES = new Set([
  'FL',
  'IF',
  'VVS',
  'VVS1',
  'VVS2',
  'VS',
  'VS1',
  'VS2',
  'SI',
  'SI1',
  'SI2',
  'SS',
  'I1',
  'I2',
  'I3',
]);
const DEFAULT_DIAMOND_SHAPES = new Set([
  'RD',
  'MQ',
  'PR',
  'EM',
  'BG',
  'PC',
  'OV',
  'CU',
  'HT',
  'RA',
  'AS',
  'TR',
]);
const DEFAULT_COLORSTONE_COLORS = new Set(['RED', 'BLUE', 'GREEN', 'PINK']);
const DEFAULT_COLORSTONE_CLARITIES = new Set(['SI', 'VS', 'VS1', 'VVS', 'VVS1']);

const addUnique = (list, value) => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return list;
  const exists = list.some((item) => item.toLowerCase() === trimmed.toLowerCase());
  if (!exists) list.push(trimmed);
  return list;
};

const buildCustomizationsFromRates = async (businessId) => {
  if (!businessId) return null;

  const [diamondRates, colorstoneRates] = await Promise.all([
    DiamondRate.find({ businessId }).lean(),
    ColorstoneRate.find({ businessId }).lean(),
  ]);

  const diamond = { colors: [], clarities: [], shapes: [], packetCodes: [] };
  diamondRates.forEach((rate) => {
    const color = String(rate.color ?? '').trim();
    const clarity = String(rate.clarity ?? '').trim();
    const shape = String(rate.shape ?? '').trim();
    const packetCode = String(rate.packetCode ?? '').trim();

    if (color && !DEFAULT_DIAMOND_COLORS.has(color.toUpperCase())) {
      addUnique(diamond.colors, color);
    }
    if (clarity && !DEFAULT_DIAMOND_CLARITIES.has(clarity.toUpperCase())) {
      addUnique(diamond.clarities, clarity);
    }
    if (shape && !DEFAULT_DIAMOND_SHAPES.has(shape.toUpperCase())) {
      addUnique(diamond.shapes, shape);
    }
    if (packetCode) {
      addUnique(diamond.packetCodes, packetCode.toUpperCase());
    }
  });

  const colorstone = { colors: [], clarities: [], shapes: [], packetCodes: [] };
  colorstoneRates.forEach((rate) => {
    const color = String(rate.color ?? '').trim();
    const clarity = String(rate.clarity ?? '').trim();

    if (color && !DEFAULT_COLORSTONE_COLORS.has(color.toUpperCase())) {
      addUnique(colorstone.colors, color);
    }
    if (clarity && !DEFAULT_COLORSTONE_CLARITIES.has(clarity.toUpperCase())) {
      addUnique(colorstone.clarities, clarity);
    }
  });

  return { diamond, colorstone };
};

const mergeCustomizations = (base, extra) => {
  if (!extra) return base;
  const merged = {
    colors: [...(base?.colors ?? [])],
    clarities: [...(base?.clarities ?? [])],
    shapes: [...(base?.shapes ?? [])],
    packetCodes: [...(base?.packetCodes ?? [])],
  };

  (extra.colors ?? []).forEach((value) => addUnique(merged.colors, value));
  (extra.clarities ?? []).forEach((value) => addUnique(merged.clarities, value));
  (extra.shapes ?? []).forEach((value) => addUnique(merged.shapes, value));
  (extra.packetCodes ?? []).forEach((value) => addUnique(merged.packetCodes, value));

  return merged;
};

// Normalize orientation and conditionally downscale for consistent OCR across devices.
const processImageToBase64 = async (filePath) => {
  const image = sharp(filePath, { failOn: 'none' });
  const metadata = await image.metadata();
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;
  const originalFormat = metadata.format || 'unknown';

  const maxEdgePx = config.ocr?.maxEdgePx || 2200;
  const jpegQuality = config.ocr?.jpegQuality || 82;
  const shouldResize = originalWidth > maxEdgePx || originalHeight > maxEdgePx;

  // Passthrough: an already-JPEG image with no EXIF rotation, within the edge
  // budget and a modest byte size gains nothing from re-encoding (OpenAI
  // rescales internally anyway) — skip sharp and send the file as-is.
  const orientation = metadata.orientation;
  if (
    originalFormat === 'jpeg' &&
    (orientation === undefined || orientation === 1) &&
    !shouldResize
  ) {
    const { size: fileBytes } = await fs.promises.stat(filePath);
    if (fileBytes <= 1.5 * 1024 * 1024) {
      const raw = await fs.promises.readFile(filePath);
      console.info('[OCR_IMAGE_PREPROCESS]', {
        filePath,
        originalFormat,
        originalWidth,
        originalHeight,
        outputBytes: raw.length,
        maxEdgePx,
        jpegQuality,
        resized: false,
        passthrough: true,
      });
      return raw.toString('base64');
    }
  }

  let pipeline = image.rotate();
  if (shouldResize) {
    pipeline = pipeline.resize({
      width: maxEdgePx,
      height: maxEdgePx,
      fit: 'inside',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    });
  }

  const compressedBuffer = await pipeline
    .jpeg({ quality: jpegQuality, mozjpeg: true })
    .toBuffer();

  console.info('[OCR_IMAGE_PREPROCESS]', {
    filePath,
    originalFormat,
    originalWidth,
    originalHeight,
    outputBytes: compressedBuffer.length,
    maxEdgePx,
    jpegQuality,
    resized: shouldResize,
  });

  return compressedBuffer.toString('base64');
};

// Deterministic post-correction for the separator-misread class:
// a bar glyph ("|", "I", "l", "/", "\") between a weight and a letter code is
// sometimes read as the digit 1, turning e.g. "0.64|PDUUU" into 0.641.
// If a weight ends in 1, does NOT itself appear in the raw OCR text, but the
// value WITHOUT the trailing 1 appears immediately followed by a bar-like
// glyph or a letter, the trailing 1 is provably the separator — strip it.
// If the evidence is ambiguous, the field's confidence is dropped instead so
// the review screen highlights it for the user. Never touches clean values.
const SEPARATOR_ADJACENT = /[|IlL\\\/A-Za-z]/;

const correctSeparatorMisreads = (parsedData) => {
  const raw = String(parsedData?.rawText?.merged ?? '');
  const sd = parsedData?.structuredData;
  if (!sd) return;

  const fixField = (field, label) => {
    if (!field || typeof field !== 'object') return;
    const val = String(field.value ?? '');
    if (!/^\d*\.\d+1$/.test(val)) return; // only decimals ending in 1
    if (!raw) return;
    if (raw.includes(val)) return; // the full value really is printed
    const trimmed = val.slice(0, -1);
    if (!/\d$/.test(trimmed)) return;
    const idx = raw.indexOf(trimmed);
    if (idx === -1) {
      // Neither variant appears in the OCR text — ambiguous; flag for review.
      if (typeof field.confidence === 'number' && field.confidence > 40) {
        field.confidence = 40;
      }
      return;
    }
    const nextChar = raw[idx + trimmed.length] || '';
    if (SEPARATOR_ADJACENT.test(nextChar)) {
      console.warn('[WEIGHT_SEPARATOR_CORRECTED]', { field: label, from: val, to: trimmed });
      field.value = trimmed;
    }
  };

  // Plausibility guard: jewellery weights are small decimals. A long plain
  // integer (e.g. 261440) in a weight field is a serial number that leaked in
  // from an SR NO / ST NO line — reject it rather than trust it.
  const rejectImplausibleWeight = (field, label) => {
    if (!field || typeof field !== 'object') return;
    const val = String(field.value ?? '').trim();
    if (!val) return;
    const numeric = Number(val.replace(/[^0-9.]/g, ''));
    const isPlainLongInteger = /^\d{4,}$/.test(val.replace(/[^0-9]/g, '')) && !val.includes('.');
    if (isPlainLongInteger || (Number.isFinite(numeric) && numeric >= 1000)) {
      console.warn('[WEIGHT_PLAUSIBILITY_REJECTED]', { field: label, value: val });
      field.value = '';
      field.confidence = 0;
    }
  };

  // Tags often print weights without a leading zero (".54") — normalize so
  // display/calculation code never drops a leading-dot decimal.
  const normalizeLeadingDot = (field) => {
    if (!field || typeof field !== 'object') return;
    const val = String(field.value ?? '').trim();
    if (/^\.\d+$/.test(val)) {
      field.value = `0${val}`;
    }
  };

  ['grossWeight', 'netWeight', 'diamondWeight', 'coloredStoneWeight'].forEach((name) => {
    fixField(sd[name], name);
    rejectImplausibleWeight(sd[name], name);
    normalizeLeadingDot(sd[name]);
  });
  if (Array.isArray(sd.diamonds)) {
    sd.diamonds.forEach((diamond, i) => {
      fixField(diamond?.weight, `diamonds[${i}].weight`);
      rejectImplausibleWeight(diamond?.weight, `diamonds[${i}].weight`);
      normalizeLeadingDot(diamond?.weight);
    });
  }
  if (Array.isArray(sd.colorstones)) {
    sd.colorstones.forEach((stone, i) => {
      fixField(stone?.weight, `colorstones[${i}].weight`);
      rejectImplausibleWeight(stone?.weight, `colorstones[${i}].weight`);
      normalizeLeadingDot(stone?.weight);
    });
  }
};

// Per-business prompt-context cache: customizations change rarely, so a short
// TTL removes the Redis reads and rate-table queries from the scan hot path.
const customizationCache = new Map();
const CUSTOMIZATION_TTL_MS = 60_000;

const getContextCached = (businessId) => {
  const key = String(businessId || 'global');
  const cached = customizationCache.get(key);
  if (cached && Date.now() - cached.at < CUSTOMIZATION_TTL_MS) {
    return cached.promise;
  }
  const promise = Promise.all([
    getPromptCustomizations('diamond', businessId),
    getPromptCustomizations('colorstone', businessId),
    buildCustomizationsFromRates(businessId),
  ]);
  // Never keep a failed fetch cached.
  promise.catch(() => {
    if (customizationCache.get(key)?.promise === promise) {
      customizationCache.delete(key);
    }
  });
  customizationCache.set(key, { at: Date.now(), promise });
  return promise;
};

const analyzeImages = async (
  frontImagePath,
  backImagePath,
  jewelleryType,
  scanType,
  scannerSettings = {},
  businessId,
  preprocessed = {},
) => {
  const tPipelineStart = Date.now();
  // Process images and fetch prompt customizations in parallel.
  // A pre-warmed base64 override (produced by the SAME processImageToBase64 on
  // the SAME file at upload time) skips on-demand preprocessing for that side.
  const [
    frontBase64,
    backBase64,
    [customizations, colorstoneCustomizations, orgCustomizations],
  ] = await Promise.all([
    preprocessed?.frontBase64
      ? preprocessed.frontBase64
      : (frontImagePath && fs.existsSync(frontImagePath) ? processImageToBase64(frontImagePath) : null),
    preprocessed?.backBase64
      ? preprocessed.backBase64
      : (backImagePath && fs.existsSync(backImagePath) ? processImageToBase64(backImagePath) : null),
    getContextCached(businessId),
  ]);
  const preprocessMs = Date.now() - tPipelineStart;
  console.log(`[TIMING] preprocess_and_context_ms=${preprocessMs}`);

  const userPromptText = getUserPrompt(jewelleryType, scanType, scannerSettings);
  const userContent = [{ type: 'text', text: userPromptText }];

  if (frontBase64) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${frontBase64}` },
    });
  }

  if (backBase64) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${backBase64}` },
    });
  }

  const mergedDiamondCustoms = mergeCustomizations(
    customizations,
    orgCustomizations?.diamond,
  );
  const mergedColorstoneCustoms = mergeCustomizations(
    colorstoneCustomizations,
    orgCustomizations?.colorstone,
  );
  const systemPromptText = getSystemPrompt(mergedDiamondCustoms, mergedColorstoneCustoms);
  const messages = [
    { role: 'system', content: systemPromptText },
    { role: 'user', content: userContent },
  ];

  const promptText = `${systemPromptText}\n\n${userPromptText}`;
  const promptWords = promptText.replace(/\s+/g, ' ').trim().split(' ');
  const promptPreview = promptWords.slice(0, 100).join(' ');
  const promptCharacters = promptText.length;
  const estimatedTokens = Math.ceil(promptCharacters / 4);
  // Overridable for A/B latency testing (scripts/latency_test.js) and ops tuning.
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
  // process.env first so scripts/latency_test.js --tier/--effort still override .env config.
  const serviceTier = process.env.OPENAI_SERVICE_TIER || config.openai.serviceTier;
  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || config.openai.reasoningEffort;
  const imageCount = Number(Boolean(frontBase64)) + Number(Boolean(backBase64));
  const timestamp = new Date().toISOString();

  if (process.env.DEBUG_AI_LOGS === 'true') {
    console.log('========== OPENAI PROMPT ==========');
    console.log(promptPreview);
    console.log(`Prompt Characters: ${promptCharacters}`);
    console.log(`Estimated Tokens: ${estimatedTokens}`);
    console.log(`Model: ${model}`);
    console.log(`Images: ${imageCount}`);
    console.log(`Timestamp: ${timestamp}`);
    console.log('==================================');
  }
  console.log(`[OPENAI_REQUEST] model=${model} images=${imageCount} promptChars=${promptCharacters} estTokens=${estimatedTokens} tier=${serviceTier || 'default'} at=${timestamp}`);

  try {
    const requestOptions = {
      model,
      messages: messages,
      response_format: { type: 'json_object' },
      max_completion_tokens: 3000,
      // Stable per-business cache routing so repeated scans hit the same
      // prompt-cache shard (system prompt + customizations are identical).
      prompt_cache_key: String(businessId || 'global'),
    };
    if (reasoningEffort) {
      requestOptions.reasoning_effort = reasoningEffort;
    }
    if (serviceTier) {
      requestOptions.service_tier = serviceTier;
    }

    const tAiStart = Date.now();
    let response;
    try {
      response = await openai.chat.completions.create(requestOptions);
    } catch (requestError) {
      // Optional speed params (service_tier / prompt_cache_key / reasoning_effort)
      // can be rejected depending on org/model eligibility. Never let a speed
      // knob kill scanning: log the real cause and retry once without them.
      console.error('[OPENAI_REQUEST_FALLBACK]', {
        error: requestError?.message || String(requestError),
        status: requestError?.status || null,
        hadServiceTier: Boolean(requestOptions.service_tier),
        hadPromptCacheKey: Boolean(requestOptions.prompt_cache_key),
        hadReasoningEffort: Boolean(requestOptions.reasoning_effort),
      });
      const minimalOptions = {
        model,
        messages: messages,
        response_format: { type: 'json_object' },
        max_completion_tokens: 3000,
      };
      response = await openai.chat.completions.create(minimalOptions);
    }
    const aiMs = Date.now() - tAiStart;

    const usage = response.usage || {};
    console.log('[OPENAI_TOKEN_USAGE]', {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    });
    console.log(`[TIMING] openai_call_ms=${aiMs} analyze_total_ms=${Date.now() - tPipelineStart}`);

    const responseText = response.choices[0].message.content;
    const parsedData = JSON.parse(responseText);

    // Deterministic guard against separator glyphs read as digits — runs
    // before the flattening below so corrected stone weights propagate.
    correctSeparatorMisreads(parsedData);

    if (process.env.DEBUG_AI_LOGS === 'true') {
      console.log("=== AI RAW RESPONSE ===");
      console.log(JSON.stringify(parsedData, null, 2));
      console.log("=======================");
    }

    // Add backward compatibility for frontend by flattening the first stone
    if (parsedData.structuredData) {
      if (parsedData.packetCode && !parsedData.structuredData.packetCode) {
        parsedData.structuredData.packetCode = parsedData.packetCode;
      }

      const packetCodeField = parsedData.structuredData.packetCode;
      if (Array.isArray(parsedData.structuredData.diamonds)) {
        parsedData.structuredData.diamonds = parsedData.structuredData.diamonds.map((diamond) => {
          if (!diamond || typeof diamond !== 'object') return diamond;
          if (diamond.packetCode) return diamond;
          if (!packetCodeField) return diamond;
          return { ...diamond, packetCode: packetCodeField };
        });
      }

      if (parsedData.structuredData.diamonds && parsedData.structuredData.diamonds.length > 0) {

        const firstDia = parsedData.structuredData.diamonds[0];
        parsedData.structuredData.diamondWeight = firstDia.weight || { value: '', confidence: 0 };
        parsedData.structuredData.diamondPieces = firstDia.pieces || { value: '', confidence: 0 };
        parsedData.structuredData.diamondRate = firstDia.rate || { value: '', confidence: 0 };
        parsedData.structuredData.diamondQuality = firstDia.quality || { value: '', confidence: 0 };
        parsedData.structuredData.diamondColor = firstDia.color || { value: '', confidence: 0 };
        parsedData.structuredData.diamondClarity = firstDia.clarity || { value: '', confidence: 0 };
        parsedData.structuredData.diamondShape = firstDia.shape || { value: '', confidence: 0 };
      }

      if (parsedData.structuredData.colorstones && parsedData.structuredData.colorstones.length > 0) {
        const firstCs = parsedData.structuredData.colorstones[0];
        parsedData.structuredData.coloredStoneWeight = firstCs.weight || { value: '', confidence: 0 };
        parsedData.structuredData.coloredStonePieces = firstCs.pieces || { value: '', confidence: 0 };
        parsedData.structuredData.coloredStoneRate = firstCs.rate || { value: '', confidence: 0 };
        parsedData.structuredData.coloredStoneQuality = firstCs.quality || { value: '', confidence: 0 };
        parsedData.structuredData.coloredStoneColor = firstCs.color || { value: '', confidence: 0 };
        parsedData.structuredData.coloredStoneClarity = firstCs.clarity || { value: '', confidence: 0 };
      }

      // Reverse synthesis: the model sometimes answers with ONLY the flat
      // diamond*/coloredStone* fields and no stones array (typical on
      // GOLD-type scans). The app's review screen is driven by the arrays,
      // so guarantee BOTH representations are always populated.
      const sd = parsedData.structuredData;
      const fieldHasValue = (field) =>
        field && typeof field === 'object' && String(field.value ?? '').trim() !== '';
      const emptyField = () => ({ value: '', confidence: 0 });

      if (
        (!Array.isArray(sd.diamonds) || sd.diamonds.length === 0) &&
        (fieldHasValue(sd.diamondWeight) || fieldHasValue(sd.diamondPieces) || fieldHasValue(sd.diamondRate))
      ) {
        console.info('[STONE_ARRAY_SYNTHESIZED]', { kind: 'diamond' });
        sd.diamonds = [{
          weight: sd.diamondWeight || emptyField(),
          pieces: sd.diamondPieces || emptyField(),
          rate: sd.diamondRate || emptyField(),
          quality: sd.diamondQuality || emptyField(),
          color: sd.diamondColor || emptyField(),
          clarity: sd.diamondClarity || emptyField(),
          shape: sd.diamondShape || emptyField(),
          ...(sd.packetCode ? { packetCode: sd.packetCode } : {}),
        }];
      }

      if (
        (!Array.isArray(sd.colorstones) || sd.colorstones.length === 0) &&
        (fieldHasValue(sd.coloredStoneWeight) || fieldHasValue(sd.coloredStonePieces) || fieldHasValue(sd.coloredStoneRate))
      ) {
        console.info('[STONE_ARRAY_SYNTHESIZED]', { kind: 'colorstone' });
        sd.colorstones = [{
          weight: sd.coloredStoneWeight || emptyField(),
          pieces: sd.coloredStonePieces || emptyField(),
          rate: sd.coloredStoneRate || emptyField(),
          quality: sd.coloredStoneQuality || emptyField(),
          color: sd.coloredStoneColor || emptyField(),
          clarity: sd.coloredStoneClarity || emptyField(),
        }];
      }
    }

    parsedData.billingMeta = {
      provider: 'openai',
      model,
      promptTokens: Number(usage.prompt_tokens || 0),
      completionTokens: Number(usage.completion_tokens || 0),
      totalTokens: Number(usage.total_tokens || 0),
    };

    return parsedData;
  } catch (err) {
    console.error('[OpenAI Error]', err);
    throw err;
  }
};

module.exports = { analyzeImages, processImageToBase64 };

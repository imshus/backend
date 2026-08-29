const { GoogleGenAI } = require('@google/genai');
const sharp = require('sharp');
const config = require('../config/env');
const { SYSTEM_PROMPT, getUserPrompt } = require('../prompts/gemini.prompt');
const fs = require('fs');

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

// Normalize orientation and conditionally downscale for reliable OCR on modern cameras.
const fileToGenerativePart = async (filePath) => {
  const image = sharp(filePath, { failOn: 'none' });
  const metadata = await image.metadata();
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;
  const originalFormat = metadata.format || 'unknown';
  const maxEdgePx = config.ocr?.maxEdgePx || 2200;
  const jpegQuality = config.ocr?.jpegQuality || 82;
  const shouldResize = originalWidth > maxEdgePx || originalHeight > maxEdgePx;

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

  return {
    inlineData: {
      data: compressedBuffer.toString('base64'),
      mimeType: 'image/jpeg',
    },
  };
};

// Retryable status codes: 503 = server overload, 429 = rate limit (transient)
const RETRYABLE_CODES = new Set([503, 429]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000; // 2s → 4s → 8s

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const callGeminiWithRetry = async (parts) => {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: parts,
        config: {
          responseMimeType: 'application/json'
        },
      });
    } catch (err) {
      lastError = err;
      const status = err?.status ?? err?.response?.status;
      const isRetryable = RETRYABLE_CODES.has(status);

      if (!isRetryable || attempt === MAX_RETRIES) {
        throw err;
      }

      const delay = BASE_DELAY_MS * Math.pow(2, attempt); // 2s, 4s, 8s
      console.warn(`[Gemini] ${status} error — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(delay);
    }
  }

  throw lastError;
};

const analyzeImages = async (frontImagePath, backImagePath, jewelleryType, scanType, scannerSettings = {}) => {
  // Build image parts in parallel to avoid sequential I/O delay
  const imageParts = await Promise.all([
    frontImagePath && fs.existsSync(frontImagePath)
      ? fileToGenerativePart(frontImagePath)
      : null,
    backImagePath && fs.existsSync(backImagePath)
      ? fileToGenerativePart(backImagePath)
      : null,
  ]);

  const parts = [
    { text: SYSTEM_PROMPT },
    { text: getUserPrompt(jewelleryType, scanType, scannerSettings) },
    ...imageParts.filter(Boolean),
  ];

  const response = await callGeminiWithRetry(parts);

  const responseText = response.text;
  try {
    const parsedData = JSON.parse(responseText);
    
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
      }

      if (parsedData.structuredData.colorstones && parsedData.structuredData.colorstones.length > 0) {
        const firstCs = parsedData.structuredData.colorstones[0];
        parsedData.structuredData.coloredStoneWeight = firstCs.weight || { value: '', confidence: 0 };
        parsedData.structuredData.coloredStonePieces = firstCs.pieces || { value: '', confidence: 0 };
        parsedData.structuredData.coloredStoneRate = firstCs.rate || { value: '', confidence: 0 };
        parsedData.structuredData.coloredStoneQuality = firstCs.quality || { value: '', confidence: 0 };
      }
    }
    
    return parsedData;
  } catch (e) {
    return { error: 'Failed to parse JSON', raw: responseText };
  }
};

module.exports = { analyzeImages };

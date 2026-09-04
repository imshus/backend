const fs = require('fs');
const sharp = require('sharp');
const config = require('../config/env');

/**
 * Image views for the tag reader.
 *
 * The vision API scales every image it receives to its own fixed pixel
 * budget, so a whole tag photo reaches the model at roughly 1.4 megapixels
 * however large the upload was. On a tag that means one to two millimetres
 * of print per thirty pixels: enough to read, not enough to tell 0 from 6 or
 * E from F with certainty. Sending overlapping parts of the same image gets
 * each part its own budget, so the same characters arrive two to three times
 * larger. The whole image still goes first, for layout and reading order.
 *
 * Two independent part layouts are produced from one decode: quarters for
 * the primary read, thirds along the long axis for the second read, so the
 * two reads see different pixels and their errors decorrelate.
 */

// The vision API scales each image it receives down to roughly this many
// pixels. A part only magnifies anything when it still carries at least that
// many of its own, so a part below the budget is the same characters
// re-encoded — a second lossy generation, and a slower scan, for nothing.
const MODEL_IMAGE_BUDGET_PX = 1_100_000;
// Below this size a magnified part carries no pixels the whole image does
// not already deliver at full budget.
const MIN_SOURCE_EDGE_PX = 1000;
// A decode ceiling: MAX_UPLOAD_MB lets a small PNG expand to hundreds of
// megabytes of raw pixels, and several at once take the process down.
const MAX_INPUT_PIXELS = 60_000_000;
// Bytes of a JPEG that goes to the model unchanged when it needs no rotation
// and no downscale; re-encoding an already compact file only loses detail.
const PASSTHROUGH_MAX_BYTES = 2.5 * 1024 * 1024;
const PART_JPEG_QUALITY = 90;

// Fractions of the upright image. Quarters at 60% overlap by 20%, so a value
// on a seam is whole in at least one part.
const QUARTERS = [
  { name: 'top-left quarter', left: 0, top: 0, width: 0.6, height: 0.6 },
  { name: 'top-right quarter', left: 0.4, top: 0, width: 0.6, height: 0.6 },
  { name: 'bottom-left quarter', left: 0, top: 0.4, width: 0.6, height: 0.6 },
  { name: 'bottom-right quarter', left: 0.4, top: 0.4, width: 0.6, height: 0.6 },
];
// Thirds along the long axis, 40% each, overlapping by 10%.
const THIRDS_ALONG_WIDTH = [
  { name: 'left third', left: 0, top: 0, width: 0.4, height: 1 },
  { name: 'middle third', left: 0.3, top: 0, width: 0.4, height: 1 },
  { name: 'right third', left: 0.6, top: 0, width: 0.4, height: 1 },
];
const THIRDS_ALONG_HEIGHT = [
  { name: 'top third', left: 0, top: 0, width: 1, height: 0.4 },
  { name: 'middle third', left: 0, top: 0.3, width: 1, height: 0.4 },
  { name: 'bottom third', left: 0, top: 0.6, width: 1, height: 0.4 },
];

const ROTATED_ORIENTATIONS = new Set([5, 6, 7, 8]);

const regionPixels = (region, width, height) => {
  const left = Math.round(region.left * width);
  const top = Math.round(region.top * height);
  const right = Math.min(width, Math.round((region.left + region.width) * width));
  const bottom = Math.min(height, Math.round((region.top + region.height) * height));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
};

/**
 * Decodes the file once (EXIF-upright, capped at OCR_MAX_EDGE_PX) and returns
 * the whole image plus its magnified parts as base64 JPEGs:
 *   { full, width, height, quarters: [{ name, base64, width, height }], thirds: [...] }
 * `quarters` and `thirds` are empty for small sources and when multi-view is
 * switched off, in which case the whole image is all the model gets.
 */
const prepareImageViews = async (filePath) => {
  const started = Date.now();
  const maxEdgePx = config.ocr?.maxEdgePx || 2400;
  const jpegQuality = config.ocr?.jpegQuality || 82;
  const multiView = config.ocr?.multiView !== false;

  const source = sharp(filePath, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS });
  const metadata = await source.metadata();
  const rotated = ROTATED_ORIENTATIONS.has(metadata.orientation);
  const uprightWidth = rotated ? metadata.height || 0 : metadata.width || 0;
  const uprightHeight = rotated ? metadata.width || 0 : metadata.height || 0;
  const longEdge = Math.max(uprightWidth, uprightHeight);
  const needsResize = longEdge > maxEdgePx;

  let pipeline = source.rotate();
  if (needsResize) {
    pipeline = pipeline.resize({
      width: maxEdgePx,
      height: maxEdgePx,
      fit: 'inside',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    });
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const upright = () => {
    const image = sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    });
    return info.channels === 4 ? image.flatten({ background: '#ffffff' }) : image;
  };

  // The whole image: the original bytes when they are already what the model
  // should see, otherwise one encode of the upright, capped pixels.
  let full;
  let passthrough = false;
  if (
    metadata.format === 'jpeg' &&
    (metadata.orientation === undefined || metadata.orientation === 1) &&
    !needsResize
  ) {
    const { size } = await fs.promises.stat(filePath);
    if (size <= PASSTHROUGH_MAX_BYTES) {
      full = await fs.promises.readFile(filePath);
      passthrough = true;
    }
  }
  if (!full) {
    full = await upright().jpeg({ quality: jpegQuality, mozjpeg: true }).toBuffer();
  }

  const encodePart = async (region) => {
    const box = regionPixels(region, info.width, info.height);
    const buffer = await upright()
      .extract(box)
      .jpeg({ quality: PART_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { name: region.name, base64: buffer.toString('base64'), width: box.width, height: box.height };
  };

  // A layout is worth cutting only while its parts still carry more pixels
  // than the model keeps; below that they are the same print re-encoded.
  const partPixels = (region) => {
    const box = regionPixels(region, info.width, info.height);
    return box.width * box.height;
  };
  const worthCutting = (layout) =>
    layout.every((region) => partPixels(region) >= MODEL_IMAGE_BUDGET_PX);

  let quarters = [];
  let thirds = [];
  const thirdLayout = info.width >= info.height ? THIRDS_ALONG_WIDTH : THIRDS_ALONG_HEIGHT;
  if (multiView && Math.max(info.width, info.height) >= MIN_SOURCE_EDGE_PX) {
    [quarters, thirds] = await Promise.all([
      worthCutting(QUARTERS) ? Promise.all(QUARTERS.map(encodePart)) : [],
      worthCutting(thirdLayout) ? Promise.all(thirdLayout.map(encodePart)) : [],
    ]);
    if (quarters.length === 0 && thirds.length === 0) {
      console.warn('[OCR_PARTS_TOO_SMALL]', {
        width: info.width,
        height: info.height,
        maxEdgePx,
        note: 'magnified parts would carry fewer pixels than the model keeps; raise OCR_MAX_EDGE_PX',
      });
    }
  }

  console.info('[OCR_IMAGE_VIEWS]', {
    filePath,
    format: metadata.format,
    sourceWidth: uprightWidth,
    sourceHeight: uprightHeight,
    width: info.width,
    height: info.height,
    resized: needsResize,
    passthrough,
    fullBytes: full.length,
    parts: quarters.length + thirds.length,
    ms: Date.now() - started,
  });

  return {
    full: full.toString('base64'),
    width: info.width,
    height: info.height,
    quarters,
    thirds,
  };
};

module.exports = { prepareImageViews, QUARTERS, THIRDS_ALONG_WIDTH, THIRDS_ALONG_HEIGHT, MIN_SOURCE_EDGE_PX };

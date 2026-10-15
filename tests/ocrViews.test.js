const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

// Set before the config module snapshots the environment: magnified parts are
// only cut while they still carry more pixels than the model keeps, so the
// cap has to be the one the reader is meant to run at (dotenv does not
// override values already present).
process.env.OCR_MAX_EDGE_PX = '2400';
const config = require('../src/config/env');
const {
  prepareImageViews,
  MIN_SOURCE_EDGE_PX,
  MODEL_IMAGE_BUDGET_PX,
  PART_SOURCE_MAX_EDGE_PX,
  MIN_JPEG_QUALITY,
  UPSCALE_BELOW_EDGE_PX,
  upscaleFactorFor,
} = require('../src/services/ocrViews');

/** Parts are sent at the model's own budget: more pixels would be discarded. */
const assertAtBudget = (part) => {
  const pixels = part.width * part.height;
  assert.ok(
    pixels <= MODEL_IMAGE_BUDGET_PX * 1.02 && pixels >= MODEL_IMAGE_BUDGET_PX * 0.9,
    `${part.name} carries ${(pixels / 1e6).toFixed(2)}MP, expected about ${(MODEL_IMAGE_BUDGET_PX / 1e6).toFixed(2)}MP`,
  );
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpscan-views-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const tagSvg = (width, height) => `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#d8d4cf"/>
  <rect x="${width * 0.1}" y="${height * 0.1}" width="${width * 0.8}" height="${height * 0.8}" rx="40" fill="#ffffff"/>
  <g font-family="Arial" font-size="${Math.round(height / 12)}" font-weight="700" fill="#1a1a1a">
    <text x="${width * 0.15}" y="${height * 0.3}">GR WT 8.208</text>
    <text x="${width * 0.15}" y="${height * 0.5}">NET WT 8.100</text>
    <text x="${width * 0.15}" y="${height * 0.7}">DIA WT .54</text>
  </g>
</svg>`;

const writeTag = async (name, width, height, options = {}) => {
  const file = path.join(tmpDir, name);
  let image = sharp(Buffer.from(tagSvg(width, height)));
  if (options.format === 'png') image = image.png();
  else image = image.jpeg({ quality: 90 });
  if (options.withExifRotation) image = image.withMetadata({ orientation: options.withExifRotation });
  await image.toFile(file);
  return file;
};

const decode = async (base64) => sharp(Buffer.from(base64, 'base64')).metadata();

test('a landscape tag yields the whole image, four overlapping quarters and three thirds along the width', async () => {
  const file = await writeTag('landscape.jpg', 2400, 1500);
  const views = await prepareImageViews(file);

  assert.ok(views.width <= config.ocr.maxEdgePx);
  const full = await decode(views.full);
  assert.equal(full.width, views.width);
  assert.equal(full.height, views.height);

  assert.equal(views.quarters.length, 4);
  assert.equal(views.thirds.length, 3);
  for (const part of views.quarters) {
    const meta = await decode(part.base64);
    assert.equal(meta.width, part.width);
    assert.equal(meta.height, part.height);
    assertAtBudget(part);
    // 60% of each edge, so neighbouring quarters overlap by 20%: the shape is
    // preserved when the part is scaled to the budget.
    assert.ok(Math.abs(part.width / part.height - views.width / views.height) < 0.05);
  }
  assert.deepEqual(
    views.thirds.map((p) => p.name),
    ['left third', 'middle third', 'right third'],
  );
  for (const part of views.thirds) {
    assertAtBudget(part);
    // 40% of the width, the full height.
    assert.ok(Math.abs(part.width / part.height - 0.4 * (views.width / views.height)) < 0.05);
  }
});

test('a portrait tag takes its thirds along the height', async () => {
  const file = await writeTag('portrait.jpg', 1500, 2400);
  const views = await prepareImageViews(file);
  assert.deepEqual(
    views.thirds.map((p) => p.name),
    ['top third', 'middle third', 'bottom third'],
  );
  for (const part of views.thirds) {
    assertAtBudget(part);
    // The full width, 40% of the height.
    assert.ok(Math.abs(part.height / part.width - 0.4 * (views.height / views.width)) < 0.05);
  }
});

test('the whole image obeys the edge cap while the parts are cut from the photo itself', async () => {
  const file = await writeTag('huge.jpg', 4000, 3000);
  const views = await prepareImageViews(file);
  assert.equal(Math.max(views.width, views.height), config.ocr.maxEdgePx);
  const full = await decode(views.full);
  assert.equal(full.width, views.width);
  assert.equal(views.quarters.length, 4);
  // This is the point of cutting from the source: a quarter covers 36% of the
  // tag and still carries as many pixels as the whole image is allowed, so it
  // reaches the model roughly 1.7x larger however the cap is set.
  assertAtBudget(views.quarters[0]);
  assert.ok(views.quarters[0].width > views.width * 0.6 * 0.8);
});

test('a photo far larger than the part source is decoded once, bounded', async () => {
  const file = await writeTag('enormous.jpg', 5200, 3900);
  const views = await prepareImageViews(file);
  assert.equal(Math.max(views.width, views.height), config.ocr.maxEdgePx);
  assert.equal(views.quarters.length, 4);
  for (const part of views.quarters) assertAtBudget(part);
  // The work buffer is capped, so a quarter of it cannot exceed the ceiling.
  assert.ok(views.quarters[0].width <= PART_SOURCE_MAX_EDGE_PX);
});

test('parts that would carry fewer pixels than the model keeps are not cut at all', async () => {
  // 1400x875 upright: a quarter is 840x525 = 0.44MP, well under the budget,
  // so cutting it would only add a second lossy generation.
  const file = await writeTag('modest.jpg', 1400, 875);
  const views = await prepareImageViews(file);
  assert.equal(views.quarters.length, 0);
  assert.equal(views.thirds.length, 0);
  assert.ok(views.full.length > 0);
});

test('a tightly cropped tag keeps only the layout whose parts are still large enough', async () => {
  // 2400x1000: thirds are 960x1000 = 0.96MP (too small), quarters 1440x600 = 0.86MP.
  const file = await writeTag('wide.jpg', 2400, 1000);
  const views = await prepareImageViews(file);
  assert.equal(views.quarters.length, 0);
  assert.equal(views.thirds.length, 0);
});

test('a small source gets no magnified parts', async () => {
  const size = MIN_SOURCE_EDGE_PX - 100;
  const file = await writeTag('small.jpg', size, Math.round(size * 0.6));
  const views = await prepareImageViews(file);
  assert.equal(views.quarters.length, 0);
  assert.equal(views.thirds.length, 0);
  assert.ok(views.full.length > 0);
});

test('EXIF rotation is applied before the parts are cut', async () => {
  // Orientation 6 = rotate 90° clockwise: a stored 2400x1500 file is a
  // 1500x2400 upright image.
  const file = await writeTag('rotated.jpg', 2400, 1500, { withExifRotation: 6 });
  const views = await prepareImageViews(file);
  // The cap (OCR_MAX_EDGE_PX, possibly set in .env) applies to the upright image.
  const scale = Math.min(1, config.ocr.maxEdgePx / 2400);
  assert.equal(views.width, Math.round(1500 * scale));
  assert.equal(views.height, Math.round(2400 * scale));
  const full = await decode(views.full);
  assert.equal(full.width, views.width);
  assert.equal(full.height, views.height);
  assert.equal(views.thirds[0].name, 'top third');
});

test('a PNG upload is delivered as JPEG', async () => {
  const file = await writeTag('tag.png', 2400, 1600, { format: 'png' });
  const views = await prepareImageViews(file);
  const full = await decode(views.full);
  assert.equal(full.format, 'jpeg');
  const part = await decode(views.quarters[0].base64);
  assert.equal(part.format, 'jpeg');
});

// ── Camera crops: enlarged once, never re-encoded below 92 ────────────────
// A camera crop is about 1100 px across; the 8 / 3 strokes of its weights
// are a few pixels thick, and a second encode at 82 smeared them.

/** A JPEG's quantisation tables, which are what its quality setting decides. */
const quantTables = (buffer) => {
  const tables = [];
  let offset = 2; // after SOI
  while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xdb) tables.push(buffer.subarray(offset + 4, offset + 2 + length).toString('hex'));
    if (marker === 0xda) break; // start of scan: no tables after it
    offset += 2 + length;
  }
  return tables.join('|');
};

/** The tables sharp writes at `quality` with these encoder settings, on any picture. */
const referenceTables = async (quality, mozjpeg) =>
  quantTables(
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } })
      .jpeg({ quality, mozjpeg })
      .toBuffer(),
  );

const withJpegQuality = async (quality, run) => {
  const before = config.ocr.jpegQuality;
  config.ocr.jpegQuality = quality;
  try {
    return await run();
  } finally {
    config.ocr.jpegQuality = before;
  }
};

test('the enlargement factor: about 2x below the threshold, never past the edge cap, 1 otherwise', () => {
  assert.equal(UPSCALE_BELOW_EDGE_PX, 1600);
  assert.equal(upscaleFactorFor(1100, 700, 2400), 2);
  assert.equal(upscaleFactorFor(700, 1100, 2400), 2);
  assert.equal(upscaleFactorFor(1500, 900, 2400), 1.6);
  assert.equal(upscaleFactorFor(UPSCALE_BELOW_EDGE_PX, 1000, 2400), 1);
  assert.equal(upscaleFactorFor(2400, 1500, 2400), 1);
  // A cap below the source never turns the enlargement into a shrink.
  assert.equal(upscaleFactorFor(1100, 700, 1000), 1);
  assert.equal(upscaleFactorFor(0, 0, 2400), 1);
});

test('a camera-sized crop is enlarged 2x, encoded once from its own pixels at quality 92 or more', async () => {
  const file = await writeTag('camera.jpg', 1100, 700);
  const views = await withJpegQuality(82, () => prepareImageViews(file));
  assert.equal(views.width, 2200);
  assert.equal(views.height, 1400);
  const sent = Buffer.from(views.full, 'base64');
  const meta = await sharp(sent).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.deepEqual([meta.width, meta.height], [2200, 1400]);
  // Not a generation of 82 on top of the phone's encode: the tables are 92's.
  assert.equal(quantTables(sent), await referenceTables(MIN_JPEG_QUALITY, false));
  // Too few pixels for a magnified part: the whole image is all that goes.
  assert.equal(views.quarters.length, 0);
  assert.equal(views.thirds.length, 0);
});

test('just under the threshold the enlargement stops at the edge cap', async () => {
  const file = await writeTag('under-threshold.jpg', 1500, 900);
  const views = await prepareImageViews(file);
  assert.deepEqual([views.width, views.height], [2400, 1440]);
  const meta = await decode(views.full);
  assert.deepEqual([meta.width, meta.height], [2400, 1440]);
});

test('an original that needs no resize and no turn is not re-encoded: its own bytes go to the model', async () => {
  for (const [name, width, height] of [
    ['at-threshold.jpg', UPSCALE_BELOW_EDGE_PX, 1000],
    ['mid.jpg', 1800, 1150],
  ]) {
    const file = await writeTag(name, width, height);
    const views = await withJpegQuality(60, () => prepareImageViews(file));
    assert.ok(Buffer.from(views.full, 'base64').equals(fs.readFileSync(file)), `${name} was re-encoded`);
    assert.deepEqual([views.width, views.height], [width, height]);
  }
});

test('an encode that cannot be avoided never goes below quality 92, whatever OCR_JPEG_QUALITY says', async () => {
  // Stored on its side (EXIF 6): it has to be turned, so it has to be encoded.
  const file = await writeTag('turned-camera.jpg', 2400, 1500, { withExifRotation: 6 });
  const views = await withJpegQuality(60, () => prepareImageViews(file));
  assert.deepEqual([views.width, views.height], [1500, 2400]);
  assert.equal(quantTables(Buffer.from(views.full, 'base64')), await referenceTables(MIN_JPEG_QUALITY, true));
  // A setting above the floor is still honoured.
  const higher = await withJpegQuality(95, () => prepareImageViews(file));
  assert.equal(quantTables(Buffer.from(higher.full, 'base64')), await referenceTables(95, true));
});

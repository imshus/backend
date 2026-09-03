const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const config = require('../src/config/env');
const { prepareImageViews, MIN_SOURCE_EDGE_PX } = require('../src/services/ocrViews');

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
    // 60% of each edge, so neighbouring quarters overlap by 20%.
    assert.ok(Math.abs(part.width - views.width * 0.6) <= 1, `${part.name} width ${part.width}`);
    assert.ok(Math.abs(part.height - views.height * 0.6) <= 1, `${part.name} height ${part.height}`);
  }
  assert.deepEqual(
    views.thirds.map((p) => p.name),
    ['left third', 'middle third', 'right third'],
  );
  for (const part of views.thirds) {
    assert.ok(Math.abs(part.width - views.width * 0.4) <= 1);
    assert.equal(part.height, views.height);
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
    assert.equal(part.width, views.width);
    assert.ok(Math.abs(part.height - views.height * 0.4) <= 1);
  }
});

test('a source larger than the edge cap is downscaled once and the parts follow the capped size', async () => {
  const file = await writeTag('huge.jpg', 4000, 3000);
  const views = await prepareImageViews(file);
  assert.equal(Math.max(views.width, views.height), config.ocr.maxEdgePx);
  const full = await decode(views.full);
  assert.equal(full.width, views.width);
  assert.equal(views.quarters.length, 4);
  assert.ok(Math.abs(views.quarters[0].width - views.width * 0.6) <= 1);
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
  const file = await writeTag('tag.png', 2000, 1200, { format: 'png' });
  const views = await prepareImageViews(file);
  const full = await decode(views.full);
  assert.equal(full.format, 'jpeg');
  const part = await decode(views.quarters[0].base64);
  assert.equal(part.format, 'jpeg');
});

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { prepareImageViews } = require('../src/services/ocrViews');

/**
 * A tag photographed the other way up.
 *
 * The reader is asked which way the print runs and the image is turned that
 * far before anything is cut from it, so the whole view, the parts and the
 * names those parts are given all describe the tag as it is printed. These
 * tests stand in their own answer for that question: what is under test is
 * that the answer is obeyed, not the model that produces it.
 */

// Big enough that the part layouts are worth cutting, and deliberately not
// square so a quarter turn is visible in the dimensions.
const WIDTH = 2400;
const HEIGHT = 1600;

/** A red band along the top edge, everything else white. */
const bannerImage = async () => {
  const base = await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  const band = await sharp({
    create: { width: WIDTH, height: 200, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
  return sharp(base)
    .composite([{ input: band, top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();
};

const writeTemp = async (buffer, name) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mrpscan-orient-'));
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, buffer);
  return file;
};

/**
 * Where the red band sits in a returned view: 'top', 'bottom' or 'side'.
 *
 * Measured from raw pixels rather than sharp's own stats(), which reports the
 * whole image however the pipeline before it was cropped — every strip then
 * comes back with the same average and the test proves nothing.
 */
const bandEdge = async (base64) => {
  const buffer = Buffer.from(base64, 'base64');
  const { width, height } = await sharp(buffer).metadata();
  const redness = async (region) => {
    const { data, info } = await sharp(buffer)
      .extract(region)
      .raw()
      .toBuffer({ resolveWithObject: true });
    let total = 0;
    for (let index = 0; index + 2 < data.length; index += info.channels) {
      total += data[index] - data[index + 2]; // red minus blue: the band is red
    }
    return total / (data.length / info.channels);
  };
  const band = Math.max(1, Math.round(Math.min(height, width) * 0.05));
  const top = await redness({ left: 0, top: 0, width, height: band });
  const bottom = await redness({ left: 0, top: height - band, width, height: band });
  if (top > 40 && top > bottom) return 'top';
  if (bottom > 40) return 'bottom';
  return 'side';
};

test('a tag the right way up is left alone', async () => {
  const file = await writeTemp(await bannerImage(), 'upright.jpg');
  const views = await prepareImageViews(file, { detectRotation: async () => 0 });

  assert.strictEqual(views.printRotation, 0);
  assert.strictEqual(await bandEdge(views.full), 'top');
});

test('an upside-down tag is turned before any part is cut from it', async () => {
  const flipped = await sharp(await bannerImage()).rotate(180).jpeg({ quality: 92 }).toBuffer();
  const file = await writeTemp(flipped, 'flipped.jpg');

  let asked = 0;
  const views = await prepareImageViews(file, {
    detectRotation: async () => {
      asked += 1;
      return 180;
    },
  });

  assert.strictEqual(asked, 1, 'the orientation question is asked once per image');
  assert.strictEqual(views.printRotation, 180);
  // Turned back: the band is at the top again, as it is on the printed tag.
  assert.strictEqual(await bandEdge(views.full), 'top');
  // And the parts are cut from the turned pixels, so "top-left quarter" is
  // the top left of the tag rather than the bottom right of the photograph.
  const topLeft = views.quarters.find((part) => part.name === 'top-left quarter');
  assert.ok(topLeft, 'quarters are still produced');
  assert.strictEqual(await bandEdge(topLeft.base64), 'top');
});

test('a tag lying on its side comes back upright, with the axes swapped', async () => {
  // Turned anticlockwise by the photographer, so it needs a clockwise quarter
  // turn back.
  const sideways = await sharp(await bannerImage()).rotate(270).jpeg({ quality: 92 }).toBuffer();
  const file = await writeTemp(sideways, 'sideways.jpg');

  const views = await prepareImageViews(file, { detectRotation: async () => 90 });

  assert.strictEqual(views.printRotation, 90);
  assert.ok(views.width > views.height, 'the landscape tag is landscape again');
  assert.strictEqual(await bandEdge(views.full), 'top');
});

test('an unanswerable orientation leaves the image exactly as it arrived', async () => {
  const file = await writeTemp(await bannerImage(), 'unknown.jpg');

  const views = await prepareImageViews(file, { detectRotation: async () => 0 });
  const untouched = await prepareImageViews(file, { detectRotation: null });

  assert.strictEqual(views.printRotation, 0);
  assert.strictEqual(untouched.printRotation, 0);
  assert.strictEqual(await bandEdge(untouched.full), 'top');
});

test('a failed orientation question does not fail the scan', async () => {
  const file = await writeTemp(await bannerImage(), 'boom.jpg');

  await assert.rejects(
    prepareImageViews(file, {
      detectRotation: async () => {
        throw new Error('model unreachable');
      },
    }),
    /model unreachable/,
    'the detector itself is what swallows its failures, and this one does not',
  );

  // The real detector answers 0 instead of throwing, which is the behaviour
  // the pipeline depends on.
  const views = await prepareImageViews(file, { detectRotation: async () => 0 });
  assert.strictEqual(views.printRotation, 0);
});

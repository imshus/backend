/**
 * Accuracy check over real tag photos.
 *
 * Runs the production reader (two independent reads over magnified parts,
 * a third look at disagreements, the deterministic repairs) on every image
 * given and prints each field with its confidence and the consensus summary.
 * With a sidecar "<image>.expected.json" beside an image, every listed field
 * is checked and a PASS/FAIL count is printed at the end.
 *
 * Usage:
 *   node scripts/accuracy_test.js <image-or-folder> [more...] [--type=DIAMOND] [--effort=low] [--model=...]
 *
 * A folder is scanned for .jpg/.jpeg/.png files. "<name>.back.jpg" next to
 * "<name>.jpg" is sent as the back of that tag.
 *
 * Sidecar format (flat keys as printed on the tag):
 *   { "grossWeight": "8.208", "netWeight": "8.100", "karat": "18K",
 *     "diamonds[0].weight": "0.54", "diamonds[0].color": "FG", "diamonds[0].clarity": "SI",
 *     "serialNumber": "GR10286" }
 *
 * NOTE: every tag costs two or three real OpenAI calls (billed to OPENAI_API_KEY).
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const TEST_BUSINESS_ID = '000000000000000000000000';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

const flag = (args, name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const collectTags = (inputs) => {
  const files = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) {
      console.error(`not found: ${resolved}`);
      continue;
    }
    if (fs.statSync(resolved).isDirectory()) {
      for (const name of fs.readdirSync(resolved).sort()) {
        if (IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) files.push(path.join(resolved, name));
      }
    } else {
      files.push(resolved);
    }
  }
  const backs = new Set(files.filter((f) => /\.back\.(jpe?g|png)$/i.test(f)));
  return files
    .filter((f) => !backs.has(f))
    .map((front) => {
      const base = front.replace(/\.(jpe?g|png)$/i, '');
      const back = [...backs].find((b) => b.replace(/\.back\.(jpe?g|png)$/i, '') === base) || null;
      const expectedPath = `${base}.expected.json`;
      const expected = fs.existsSync(expectedPath) ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')) : null;
      return { front, back, expected };
    });
};

const fieldAt = (sd, key) => {
  const stone = /^(diamonds|colorstones)\[(\d+)\]\.(\w+)$/.exec(key);
  const holder = stone ? (sd[stone[1]] || [])[Number(stone[2])] : sd;
  const field = holder ? holder[stone ? stone[3] : key] : null;
  if (!field) return { value: '', confidence: 0 };
  if (typeof field === 'object') return { value: String(field.value ?? ''), confidence: Number(field.confidence) || 0 };
  return { value: String(field), confidence: 0 };
};

const printField = (sd, key) => {
  const { value, confidence } = fieldAt(sd, key);
  if (!value) return;
  const mark = confidence < 80 ? '  <- check' : '';
  console.log(`  ${key.padEnd(24)} ${value.padEnd(14)} conf ${String(confidence).padStart(3)}${mark}`);
};

async function main() {
  const args = process.argv.slice(2);
  const inputs = args.filter((a) => !a.startsWith('--'));
  if (!inputs.length) {
    console.error('usage: node scripts/accuracy_test.js <image-or-folder> [more...] [--type=DIAMOND] [--effort=low]');
    process.exit(1);
  }
  if (flag(args, 'model')) process.env.OPENAI_MODEL = flag(args, 'model');
  if (flag(args, 'effort')) process.env.OPENAI_REASONING_EFFORT = flag(args, 'effort');
  if (flag(args, 'tier')) process.env.OPENAI_SERVICE_TIER = flag(args, 'tier');
  const jewelleryType = (flag(args, 'type') || 'DIAMOND').toUpperCase();

  const config = require('../src/config/env');
  const { canonical } = require('../src/services/ocrConsensus');
  const tags = collectTags(inputs);
  if (!tags.length) {
    console.error('no images found');
    process.exit(1);
  }
  console.log(`=== TAG ACCURACY TEST: ${tags.length} tag(s), type ${jewelleryType}, doubleRead=${config.ocr.doubleRead}, adjudicate=${config.ocr.adjudicate}, multiView=${config.ocr.multiView}`);

  await mongoose.connect(config.mongodb.uri, { serverSelectionTimeoutMS: 15000 });
  const openaiService = require('../src/services/openai.service');

  let pass = 0;
  let fail = 0;
  try {
    for (const tag of tags) {
      console.log(`\n--- ${path.basename(tag.front)}${tag.back ? ` + ${path.basename(tag.back)}` : ''}`);
      const started = Date.now();
      let result;
      try {
        result = await openaiService.analyzeImages(
          tag.front,
          tag.back,
          jewelleryType,
          tag.back ? 'BOTH_SIDES' : 'SINGLE_SIDE',
          {},
          TEST_BUSINESS_ID,
        );
      } catch (error) {
        console.log(`  FAILED after ${Date.now() - started}ms: ${error.message}`);
        fail += 1;
        continue;
      }
      const sd = result.structuredData || {};
      console.log(`  ${Date.now() - started}ms, consensus ${JSON.stringify(result.consensus || null)}`);
      for (const key of ['serialNumber', 'grossWeight', 'netWeight', 'purity', 'karat', 'labour', 'packetCode']) printField(sd, key);
      for (const group of ['diamonds', 'colorstones']) {
        (sd[group] || []).forEach((_, i) => {
          for (const f of ['shape', 'type', 'color', 'clarity', 'weight', 'pieces', 'rate', 'packetCode']) printField(sd, `${group}[${i}].${f}`);
        });
      }
      if (result.unknownFields?.length) {
        console.log(`  unknownFields: ${result.unknownFields.map((u) => `${u.abbreviation || u.label || ''}=${u.detectedValue || u.value || ''}`).join(', ')}`);
      }
      if (tag.expected) {
        for (const [key, expectedValue] of Object.entries(tag.expected)) {
          const fieldName = key.includes('.') ? key.split('.').pop() : key;
          const actual = fieldAt(sd, key).value;
          const ok = canonical(fieldName, actual) === canonical(fieldName, expectedValue);
          if (ok) pass += 1;
          else fail += 1;
          console.log(`  ${ok ? 'PASS' : 'FAIL'} ${key}: expected "${expectedValue}", got "${actual}"`);
        }
      }
    }
  } finally {
    await mongoose.disconnect();
  }
  if (pass + fail) console.log(`\n=== ${pass} pass, ${fail} fail (${Math.round((pass / (pass + fail)) * 100)}%)`);
  process.exit(0);
}

main();

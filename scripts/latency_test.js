/**
 * One-shot scan latency test: generates a jewellery tag image (or uses a
 * provided path), runs the real analyzeImages pipeline once, and prints
 * per-stage timings + extraction results.
 *
 * Usage: node scripts/latency_test.js [imagePath] [--model=gpt-5.6-mini] [--effort=low] [--tier=priority] [--edge=1600]
 *   --model   override the OpenAI model for this run
 *   --effort  set reasoning_effort (low|medium|high)
 *   --tier    set service_tier (e.g. priority)
 *   --edge    override OCR_MAX_EDGE_PX for this run
 * NOTE: makes ONE real OpenAI call (billed to OPENAI_API_KEY).
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const sharp = require('sharp');
// NOTE: src/config/env is required lazily inside main() AFTER CLI overrides
// are applied — it snapshots process.env at require time.

const TEST_BUSINESS_ID = '000000000000000000000000';

async function generateTagImage(outPath) {
  // Mirrors the user's sample tag: DIA/GR/NET/CS weights + serial numbers.
  const svg = `
  <svg width="2400" height="1800" xmlns="http://www.w3.org/2000/svg">
    <rect width="2400" height="1800" fill="#d8d4cf"/>
    <g transform="rotate(-8 1200 900)">
      <rect x="500" y="380" width="1450" height="1050" rx="60" fill="#ffffff" stroke="#cccccc" stroke-width="6"/>
      <g font-family="Arial, Helvetica, sans-serif" font-size="118" font-weight="700" fill="#1a1a1a">
        <text x="620" y="580">DIA WT</text><text x="1420" y="580">.54</text>
        <text x="620" y="740">GR. WT</text><text x="1420" y="740">8.208</text>
        <text x="620" y="900">NET WT</text><text x="1420" y="900">8.100</text>
        <text x="620" y="1060">CS WT</text>
        <text x="620" y="1220">SR NO</text><text x="1420" y="1220">261440</text>
        <text x="620" y="1380">ST NO</text><text x="1420" y="1380">GR10286</text>
      </g>
    </g>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(outPath);
  const stat = fs.statSync(outPath);
  return stat.size;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : null;
  };
  const argPath = args.find((a) => !a.startsWith('--'));
  let imagePath = argPath ? path.resolve(argPath) : null;

  // Apply overrides BEFORE requiring the service.
  if (flag('model')) process.env.OPENAI_MODEL = flag('model');
  if (flag('effort')) process.env.OPENAI_REASONING_EFFORT = flag('effort');
  if (flag('tier')) process.env.OPENAI_SERVICE_TIER = flag('tier');
  if (flag('edge')) process.env.OCR_MAX_EDGE_PX = flag('edge');
  const jewelleryType = (flag('type') || 'DIAMOND').toUpperCase();

  console.log('=== SCAN LATENCY TEST ===');
  console.log(`overrides: model=${flag('model') || '(default)'} effort=${flag('effort') || '(none)'} tier=${flag('tier') || '(none)'} edge=${flag('edge') || '(default 2200)'}`);

  const config = require('../src/config/env');

  const tImgStart = Date.now();
  if (!imagePath) {
    imagePath = path.join(__dirname, 'latency_test_tag.jpg');
    const bytes = await generateTagImage(imagePath);
    console.log(`[stage] test image generated: ${imagePath} (${(bytes / 1024).toFixed(0)} KB) in ${Date.now() - tImgStart}ms`);
  } else {
    console.log(`[stage] using provided image: ${imagePath} (${(fs.statSync(imagePath).size / 1024).toFixed(0)} KB)`);
  }

  const tMongoStart = Date.now();
  try {
    await mongoose.connect(config.mongodb.uri, { serverSelectionTimeoutMS: 15000 });
    console.log(`[stage] mongo connected in ${Date.now() - tMongoStart}ms`);
  } catch (err) {
    console.error(`[stage] mongo connect FAILED after ${Date.now() - tMongoStart}ms: ${err.message}`);
    process.exit(1);
  }

  // Require after mongoose is ready (models register on require).
  const openaiService = require('../src/services/openai.service');

  const tAnalyzeStart = Date.now();
  try {
    const result = await openaiService.analyzeImages(
      imagePath,
      null,
      jewelleryType,
      'single',
      {},
      TEST_BUSINESS_ID,
    );
    const totalMs = Date.now() - tAnalyzeStart;

    console.log('\n=== RESULTS ===');
    console.log(`end_to_end_analyze_ms=${totalMs}`);
    const sd = result?.structuredData || {};
    const pick = (f) => (sd[f] && typeof sd[f] === 'object' ? `${sd[f].value} (conf ${sd[f].confidence})` : JSON.stringify(sd[f]));
    console.log('grossWeight:', pick('grossWeight'));
    console.log('netWeight:', pick('netWeight'));
    console.log('diamondWeight:', pick('diamondWeight'));
    console.log('packetCode:', pick('packetCode'));
    console.log('unknownFields:', JSON.stringify(result?.unknownFields ?? null));
    console.log('rawText.merged:', JSON.stringify(result?.rawText?.merged ?? null));
  } catch (err) {
    console.error(`analyze FAILED after ${Date.now() - tAnalyzeStart}ms:`, err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main();

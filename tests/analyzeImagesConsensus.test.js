/**
 * Drives analyzeImages end to end against a fake OpenAI endpoint: the two
 * reads, the third look at their disagreement, the deterministic repairs and
 * the flattening for the app. No real model call is made.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpscan-analyze-'));

// The fake API answers by what the request asks for.
const requests = [];
/** Set to fail every read that carries magnified parts. */
let failPartReads = false;
const answerFor = (body) => {
  const user = body.messages.find((m) => m.role === 'user');
  const texts = user.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const images = user.content.filter((c) => c.type === 'image_url').length;
  const kind = texts.startsWith('Two independent readings')
    ? 'adjudicate'
    : texts.includes('quarter')
      ? 'read-a'
      : texts.includes('third')
        ? 'read-b'
        : 'read-plain';
  requests.push({ kind, images, body, texts, system: body.messages[0]?.content ?? '' });
  if (failPartReads && (kind === 'read-a' || kind === 'read-b')) return null;
  if (kind === 'adjudicate') {
    return { answers: { 'diamonds[0].weight': ['.54', 96] } };
  }
  const weight = kind === 'read-a' ? '5.54' : '.54';
  return {
    provider: 'openai-test',
    rawText: { merged: `DIA WT ${weight} GR WT 8.208 NET WT 8.100 ST NO GR10286` },
    structuredData: {
      serialNumber: ['GR10286', 95],
      packetCode: ['', 0],
      grossWeight: ['8.208', 97],
      netWeight: ['8.100', 97],
      purity: ['', 0],
      karat: ['18K', 90],
      labour: ['', 0],
      diamonds: [
        {
          shape: ['PC', 92],
          packetCode: ['', 0],
          weight: [weight, 88],
          pieces: ['', 0],
          rate: ['', 0],
          quality: ['FG SI', 90],
          color: ['FG', 90],
          clarity: ['SI', 90],
        },
      ],
      colorstones: [],
    },
    unknownFields: kind === 'read-a' ? [] : [{ abbreviation: 'SR NO', detectedValue: '261440', suggestedMeaning: '', confidence: 90 }],
    clarificationRequired: false,
    overallConfidence: 90,
  };
};

let server;
let baseUrl;
test.before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const answer = answerFor(body);
      if (answer === null) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream unavailable' } }));
        return;
      }
      const content = JSON.stringify(answer);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.OPENAI_BASE_URL = baseUrl;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// One file per call: libvips maps an input file into memory, and Windows will
// not let a mapped file be rewritten.
let tagCount = 0;
const tagImage = async () => {
  const svg = `
  <svg width="2400" height="1500" xmlns="http://www.w3.org/2000/svg">
    <rect width="2400" height="1500" fill="#d8d4cf"/>
    <rect x="300" y="200" width="1800" height="1100" rx="50" fill="#ffffff"/>
    <g font-family="Arial" font-size="120" font-weight="700" fill="#1a1a1a">
      <text x="420" y="420">DIA WT .54</text>
      <text x="420" y="620">GR WT 8.208</text>
      <text x="420" y="820">NET WT 8.100</text>
      <text x="420" y="1020">ST NO GR10286</text>
    </g>
  </svg>`;
  tagCount += 1;
  const file = path.join(tmpDir, `tag-${tagCount}.jpg`);
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(file);
  return file;
};

test('two reads, one disagreement, one adjudication: the tag comes out consistent and flattened', async () => {
  // No business: no Redis or Mongo lookups for customizations.
  const redisService = require('../src/services/redis.service');
  redisService.getPromptCustomizations = async () => null;
  const openaiService = require('../src/services/openai.service');

  const file = await tagImage();
  const result = await openaiService.analyzeImages(file, null, 'DIAMOND', 'SINGLE_SIDE', {}, null);

  // Three calls: read A (whole + 4 quarters), read B (whole + 3 thirds), the third look (whole + 4 quarters).
  assert.deepEqual(
    requests.map((r) => `${r.kind}:${r.images}`).sort(),
    ['adjudicate:5', 'read-a:5', 'read-b:4'],
  );
  for (const r of requests) {
    const user = r.body.messages.find((m) => m.role === 'user');
    assert.ok(user.content.every((c) => c.type !== 'image_url' || c.image_url.detail === 'high'));
    assert.equal(r.body.response_format.type, 'json_object');
    assert.equal(r.body.max_completion_tokens, r.kind === 'adjudicate' ? 3000 : 6000);
    assert.equal(r.body.messages[0].role, 'system');
  }
  const adjudication = requests.find((r) => r.kind === 'adjudicate');
  // Each reading is normalised before they are compared, so the leading zero
  // read B omitted is already there when the two are put side by side.
  assert.match(adjudication.texts, /diamonds\[0\]\.weight: reading A "5\.54", reading B "0\.54"/);

  const sd = result.structuredData;
  assert.equal(sd.grossWeight.value, '8.208');
  assert.equal(sd.grossWeight.confidence, 97);
  // The contested weight was settled by the third look and normalised.
  assert.equal(sd.diamonds[0].weight.value, '0.54');
  assert.equal(sd.diamonds[0].weight.confidence, 85);
  assert.equal(sd.diamondWeight.value, '0.54');
  assert.equal(sd.diamondColor.value, 'FG');
  assert.equal(sd.serialNumber.value, 'GR10286');
  // Agreed: serialNumber, grossWeight, netWeight, karat, and the stone's shape, quality, color, clarity.
  assert.deepEqual(result.consensus, { mode: 'double', agreements: 8, disagreements: 1, adjudicated: 1 });
  assert.equal(result.unknownFields.length, 1);
  assert.equal(result.billingMeta.promptTokens, 3000);
  assert.equal(result.billingMeta.totalTokens, 3600);
});

test('the third look is briefed on its own question, not on the extraction schema', async () => {
  const adjudication = requests.find((r) => r.kind === 'adjudicate');
  assert.ok(adjudication, 'an adjudication call was made');
  assert.match(adjudication.system, /You read characters off photographs/);
  assert.ok(
    !/structuredData/.test(adjudication.system),
    'the tag schema must not be what the adjudicator is told to return',
  );
  assert.ok(adjudication.system.length < 1000);
});

test('a scan whose images are gone is refused rather than answered from the prompt alone', async () => {
  const openaiService = require('../src/services/openai.service');
  const before = requests.length;
  await assert.rejects(
    () => openaiService.analyzeImages(path.join(tmpDir, 'deleted.jpg'), null, 'DIAMOND', 'SINGLE_SIDE', {}, null),
    /No readable image/,
  );
  assert.equal(requests.length, before, 'no model call is made without an image');
});

test('when both reads fail, one plain whole-image call is made instead of giving up', async () => {
  requests.length = 0;
  failPartReads = true;
  try {
    const openaiService = require('../src/services/openai.service');
    const file = await tagImage();
    const result = await openaiService.analyzeImages(file, null, 'DIAMOND', 'SINGLE_SIDE', {}, null);
    const kinds = requests.map((r) => r.kind);
    assert.deepEqual(kinds.filter((k) => k === 'read-plain'), ['read-plain']);
    const plain = requests.find((r) => r.kind === 'read-plain');
    assert.equal(plain.images, 1, 'the whole image only');
    assert.equal(result.consensus.mode, 'plain');
    assert.equal(result.structuredData.grossWeight.value, '8.208');
  } finally {
    failPartReads = false;
  }
});

test('with the second read switched off a single read still answers', async () => {
  process.env.OCR_DOUBLE_READ = 'false';
  try {
    requests.length = 0;
    const openaiService = require('../src/services/openai.service');
    const file = await tagImage();
    const result = await openaiService.analyzeImages(file, null, 'DIAMOND', 'SINGLE_SIDE', {}, null);
    assert.deepEqual(requests.map((r) => r.kind), ['read-a']);
    assert.equal(result.consensus.mode, 'single');
    // Read A alone said 5.54; the weight identity repairs it from gross minus net.
    assert.equal(result.structuredData.diamonds[0].weight.value, '0.54');
    assert.ok(result.structuredData.diamonds[0].weight.confidence <= 75);
  } finally {
    delete process.env.OCR_DOUBLE_READ;
  }
});

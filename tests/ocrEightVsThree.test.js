/**
 * An 8 read as a 3. Three defences, each tested offline:
 *   - the prompt tells the reader which side of the glyph decides it;
 *   - the weights are cross-checked (gross = net + 0.2 g per diamond carat),
 *     and a single lookalike digit that makes them close is corrected and
 *     marked for review, while anything less certain is only marked;
 *   - end to end against a fake OpenAI endpoint, a camera-sized crop reaches
 *     the model enlarged and the misread gross comes back corrected.
 * No real model call is made.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

// Before the config module snapshots the environment (dotenv does not
// override values already present): the edge cap the reader runs at.
process.env.OCR_MAX_EDGE_PX = '2400';
delete process.env.OCR_UPSCALE_BELOW_PX;

// The fake API, started before the reader (and its OpenAI client) is loaded.
const requests = [];
let readAnswer = null;
let server;
test.before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const user = body.messages.find((m) => m.role === 'user');
      const texts = user.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const kind = texts.startsWith('Which way up') ? 'print-rotation' : 'read';
      requests.push({ kind, body });
      const answer = kind === 'print-rotation' ? { rotate: 0 } : readAnswer;
      // No kept-alive sockets left behind: closing them while the runner
      // force-exits trips a libuv assertion on Windows.
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const reader = () => require('../src/services/openai.service');
const internal = () => reader()._internal;

const field = (value, confidence = 95) => ({ value, confidence });
const reading = (gross, net, diamonds = [], colorstones = [], extra = {}) => ({
  structuredData: {
    serialNumber: field('38813'),
    packetCode: field('PC38'),
    grossWeight: field(gross),
    netWeight: field(net),
    diamonds: diamonds.map((weight) => ({ weight: field(weight) })),
    colorstones: colorstones.map((weight) => ({ weight: field(weight) })),
  },
  ...extra,
});

/** The app's amber "check" mark: below 80. */
const flagged = (f) => f.confidence < 80 && typeof f.reason === 'string' && f.reason.length > 0;
const untouched = (f, value) => {
  assert.equal(f.value, value);
  assert.equal(f.confidence, 95);
  assert.equal(f.reason, undefined);
};

test('the prompt tells the reader to check the left side of the glyph', () => {
  const { getSystemPrompt } = require('../src/prompts/openai.prompt');
  const prompt = getSystemPrompt();
  assert.match(prompt, /An 8 is closed on the left, a 3 is open on the left/);
  assert.match(prompt, /6\/8,\s+5\/6, 0\/8/);
  assert.match(prompt, /check the left side of the glyph before writing 3 or 8 in a\s+weight or code/);
});

test('weights that already close are never changed', () => {
  const { crossCheckWeights } = internal();
  const data = reading('8.208', '8.100', ['0.54']);
  crossCheckWeights(data);
  untouched(data.structuredData.grossWeight, '8.208');
  untouched(data.structuredData.netWeight, '8.100');
  untouched(data.structuredData.diamonds[0].weight, '0.54');

  // A plain gold tag, gross equal to net.
  const gold = reading('8.100', '8.100');
  crossCheckWeights(gold);
  untouched(gold.structuredData.grossWeight, '8.100');
  untouched(gold.structuredData.netWeight, '8.100');
});

test('a gross above net + diamonds is never read as a misread', () => {
  const { correctLookalikeWeightDigit } = internal();
  // The shop's own arithmetic (12.00 / 8.00 / 2.00 ct), and a tag carrying
  // colour stones: both weigh more than net + diamonds, legitimately.
  for (const data of [reading('12.00', '8.00', ['2.00']), reading('8.900', '8.100', ['0.54'], ['2.10'])]) {
    assert.equal(correctLookalikeWeightDigit(data).outcome, 'consistent');
    untouched(data.structuredData.grossWeight, data.structuredData.grossWeight.value);
    untouched(data.structuredData.netWeight, data.structuredData.netWeight.value);
  }
});

test('a gross read 3 for 8 is corrected and marked for review with the reason', () => {
  const { crossCheckWeights } = internal();
  // 10.830 = 10.722 + 0.54 ct x 0.2; read as 10.330, net + diamonds is 0.5 g over gross.
  const data = reading('10.330', '10.722', ['0.54']);
  crossCheckWeights(data);
  const sd = data.structuredData;
  assert.equal(sd.grossWeight.value, '10.830');
  assert.ok(flagged(sd.grossWeight));
  assert.match(sd.grossWeight.reason, /Read as 10\.330/);
  assert.match(sd.grossWeight.reason, /3 as 8/);
  untouched(sd.netWeight, '10.722');
  untouched(sd.diamonds[0].weight, '0.54');
  // Codes and serial numbers are never part of it.
  untouched(sd.serialNumber, '38813');
  untouched(sd.packetCode, 'PC38');
});

test('a net read 8 for 3 is corrected and marked', () => {
  const { crossCheckWeights } = internal();
  // 4.458 = 4.350 + 0.108; read as 4.850 the net is above the gross.
  const data = reading('4.458', '4.850', ['.54']);
  crossCheckWeights(data);
  assert.equal(data.structuredData.netWeight.value, '4.350');
  assert.ok(flagged(data.structuredData.netWeight));
  untouched(data.structuredData.grossWeight, '4.458');
  untouched(data.structuredData.diamonds[0].weight, '.54');
});

test('a diamond weight read 8 for 3 is corrected and marked', () => {
  const { crossCheckWeights } = internal();
  // 6.168 = 6.100 + 0.34 ct x 0.2; 0.84 ct would need a gross of 6.268.
  const data = reading('6.168', '6.100', ['0.84']);
  crossCheckWeights(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '0.34');
  assert.ok(flagged(data.structuredData.diamonds[0].weight));
  untouched(data.structuredData.grossWeight, '6.168');
  untouched(data.structuredData.netWeight, '6.100');
});

test('the other lookalikes (5/6) are corrected the same way', () => {
  const { crossCheckWeights } = internal();
  // 5.658 = 5.550 + 0.108; the net read 5.650.
  const data = reading('5.658', '5.650', ['.54']);
  crossCheckWeights(data);
  assert.equal(data.structuredData.netWeight.value, '5.550');
  assert.ok(flagged(data.structuredData.netWeight));
});

test('a tag with colour stones is never corrected, only marked', () => {
  const { crossCheckWeights } = internal();
  // Without the colour stone this would be the unique 10.330 -> 10.830 repair.
  const data = reading('10.330', '10.722', ['0.54'], ['0.40']);
  crossCheckWeights(data);
  const sd = data.structuredData;
  assert.equal(sd.grossWeight.value, '10.330');
  assert.equal(sd.netWeight.value, '10.722');
  assert.ok(flagged(sd.grossWeight));
  assert.ok(flagged(sd.netWeight));
  assert.match(sd.grossWeight.reason, /above gross/);
  untouched(sd.colorstones[0].weight, '0.40');
});

test('a tag the reading shows carrying pearls or enamel is never corrected', () => {
  const { crossCheckWeights } = internal();
  const pearlLabel = reading('10.330', '10.722', ['0.54'], [], {
    unknownFields: [{ abbreviation: 'PEARL WT', detectedValue: '0.60', suggestedMeaning: '', confidence: 90 }],
  });
  const enamelLine = reading('10.330', '10.722', ['0.54'], [], {
    rawText: { merged: 'GR WT 10.330\nNET WT 10.722\nMEENA WT 0.35\nDIA .54' },
  });
  for (const data of [pearlLabel, enamelLine]) {
    crossCheckWeights(data);
    assert.equal(data.structuredData.grossWeight.value, '10.330');
    assert.equal(data.structuredData.netWeight.value, '10.722');
    assert.ok(flagged(data.structuredData.grossWeight));
  }
  // A shop called "Pearl Jewellers" carries no pearl: the repair still applies.
  const shopName = reading('10.330', '10.722', ['0.54'], [], { rawText: { merged: 'PEARL JEWELLERS\nGR WT 10.330' } });
  crossCheckWeights(shopName);
  assert.equal(shopName.structuredData.grossWeight.value, '10.830');
});

test('when no single lookalike change explains it, the values stay and the weights are marked', () => {
  const { crossCheckWeights } = internal();
  // 8.208 / 8.100 and 3.208 / 3.100 both close: which one is printed is a guess.
  const both = reading('3.208', '8.100', ['.54']);
  crossCheckWeights(both);
  assert.equal(both.structuredData.grossWeight.value, '3.208');
  assert.equal(both.structuredData.netWeight.value, '8.100');
  assert.ok(flagged(both.structuredData.grossWeight));
  assert.ok(flagged(both.structuredData.netWeight));
  // The diamond weight closes the sum either way, so it is not the suspect.
  untouched(both.structuredData.diamonds[0].weight, '.54');

  // No lookalike change closes it at all.
  const none = reading('7.200', '8.100');
  crossCheckWeights(none);
  assert.equal(none.structuredData.grossWeight.value, '7.200');
  assert.equal(none.structuredData.netWeight.value, '8.100');
  assert.ok(flagged(none.structuredData.grossWeight));
  assert.ok(flagged(none.structuredData.netWeight));
});

test('a shortfall within reach of rounding is marked, never pinned on a thousandths digit', () => {
  const { crossCheckWeights } = internal();
  // 8.190 is 0.018 g short of 8.100 + 0.108; reading its last 0 as an 8 would
  // "close" it, but rounding explains a gap that small just as well.
  const data = reading('8.190', '8.100', ['.54']);
  crossCheckWeights(data);
  assert.equal(data.structuredData.grossWeight.value, '8.190');
  assert.ok(flagged(data.structuredData.grossWeight));
});

test('the stone-weight repairs that came before still apply', () => {
  const { crossCheckWeights } = internal();
  // A spurious leading digit is not a lookalike slip: 5.54 -> 0.54 as before.
  const data = reading('8.208', '8.100', ['5.54']);
  crossCheckWeights(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '0.54');
  assert.ok(data.structuredData.diamonds[0].weight.confidence <= 75);
  untouched(data.structuredData.grossWeight, '8.208');
});

test('end to end: a camera crop reaches the model enlarged and a gross read 3 for 8 comes back corrected', async () => {
  const redisService = require('../src/services/redis.service');
  redisService.getPromptCustomizations = async () => null;
  readAnswer = {
    rawText: { merged: 'GR WT 10.330 NET WT 10.722 DIA .54 SR 38813' },
    structuredData: {
      serialNumber: ['38813', 95],
      packetCode: ['', 0],
      grossWeight: ['10.330', 96],
      netWeight: ['10.722', 96],
      purity: ['', 0],
      karat: ['18K', 90],
      labour: ['', 0],
      diamonds: [{ weight: ['.54', 92], pieces: ['', 0], rate: ['', 0], quality: ['', 0], color: ['', 0], clarity: ['', 0], shape: ['', 0], packetCode: ['', 0] }],
      colorstones: [],
    },
    unknownFields: [],
    clarificationRequired: false,
    overallConfidence: 90,
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpscan-8v3-'));
  try {
    const file = path.join(dir, 'crop.jpg');
    const svg = `<svg width="1100" height="700" xmlns="http://www.w3.org/2000/svg">
      <rect width="1100" height="700" fill="#ffffff"/>
      <text x="60" y="200" font-family="Arial" font-size="70" fill="#111">GR WT 10.830</text>
      <text x="60" y="380" font-family="Arial" font-size="70" fill="#111">NET WT 10.722</text>
    </svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(file);

    const result = await reader().analyzeImages(file, null, 'DIAMOND', 'SINGLE_SIDE', {}, null);

    const read = requests.find((r) => r.kind === 'read');
    assert.ok(read, 'the tag was read');
    assert.match(read.body.messages[0].content, /An 8 is closed on the left/);
    const image = read.body.messages[1].content.find((c) => c.type === 'image_url');
    const sent = await sharp(Buffer.from(image.image_url.url.split(',')[1], 'base64')).metadata();
    assert.deepEqual([sent.width, sent.height], [2200, 1400]);

    const sd = result.structuredData;
    assert.equal(sd.grossWeight.value, '10.830');
    assert.ok(sd.grossWeight.confidence < 80);
    assert.match(sd.grossWeight.reason, /Read as 10\.330/);
    assert.equal(sd.netWeight.value, '10.722');
    assert.equal(sd.serialNumber.value, '38813');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The which-way-up question no longer stands in front of the reads, against a
 * fake OpenAI endpoint (no real model call):
 *  - the reads start on the upright views while the question is answered;
 *    an answer of 0 keeps them: nothing is sent twice;
 *  - a turned tag (180) aborts them at the API and reads the turned views;
 *    the aborted reads are not billed (billingMeta) and nothing fails;
 *  - an answer already in (asked at upload) sends the right reads at once;
 *  - an unclear answer (the question failed) is read as it arrived, as before;
 *  - the speculative read at upload does the same, and the scan is written
 *    and billed once.
 */
process.env.USE_MEMORY_STORE = 'true';
process.env.SCAN_STORE = 'memory';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpscan-rotation-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 10_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return false;
    await sleep(5);
  }
  return true;
};

// ── The fake API ────────────────────────────────────────────────────────────
// The orientation answer can be held until the test lets it go, so the reads
// are seen going out while it is still unanswered.
const api = { requests: [], rotate: 0, holdRotation: false, failRotation: false, held: [], holdReads: false, heldReads: [] };

const kindOf = (body) => {
  const user = body.messages.find((m) => m.role === 'user');
  const texts = (Array.isArray(user?.content) ? user.content : [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (texts.startsWith('Which way up')) return 'print-rotation';
  if (texts.startsWith('Two independent readings')) return 'adjudicate';
  if (texts.includes('quarter')) return 'read-a';
  if (texts.includes('third')) return 'read-b';
  return 'read-plain';
};
const firstImageOf = (body) =>
  body.messages[1].content.find((c) => c.type === 'image_url')?.image_url.url || '';

const READING = {
  provider: 'openai-test',
  rawText: { merged: 'GR WT 8.208 NET WT 8.100 ST NO GR10286' },
  structuredData: {
    serialNumber: ['GR10286', 95],
    grossWeight: ['8.208', 97],
    netWeight: ['8.100', 97],
    karat: ['18K', 90],
    labour: ['', 0],
    diamonds: [],
    colorstones: [],
  },
  unknownFields: [],
  clarificationRequired: false,
  overallConfidence: 90,
};

let server;
test.before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const entry = { kind: kindOf(body), body, image: firstImageOf(body), answered: false, aborted: false };
      api.requests.push(entry);
      res.on('close', () => {
        if (!entry.answered) entry.aborted = true;
      });
      const respond = () => {
        if (res.destroyed) return;
        entry.answered = true;
        if (entry.kind === 'print-rotation' && api.failRotation) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'upstream unavailable' } }));
          return;
        }
        const json = entry.kind === 'print-rotation' ? { rotate: api.rotate } : READING;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'fake',
            choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(json) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
          }),
        );
      };
      if (entry.kind === 'print-rotation' && api.holdRotation) api.held.push(respond);
      else if (entry.kind.startsWith('read') && api.holdReads) api.heldReads.push(respond);
      else if (entry.kind.startsWith('read')) setTimeout(respond, 40);
      else respond();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  load();
});
test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const releaseRotation = () => {
  api.holdRotation = false;
  for (const respond of api.held.splice(0)) respond();
};
const releaseReads = () => {
  api.holdReads = false;
  for (const respond of api.heldReads.splice(0)) respond();
};

// ── Logs and billing, stood in for ──────────────────────────────────────────
const logs = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level];
  console[level] = (...args) => {
    logs.push({ level, tag: String(args[0]) });
    if (level === 'warn' || level === 'error') original.apply(console, args);
  };
}
const failureLogsSince = (mark) =>
  logs.slice(mark).map((entry) => entry.tag).filter((tag) => /FAILED|OpenAI Error|RETRY_PLAIN/.test(tag));

const bills = [];
let openaiService;
let scanService;
let ocrPreprocessCache;
let redisService;
function load() {
  redisService = require('../src/services/redis.service');
  redisService.getPromptCustomizations = async () => null;
  require('../src/models/diamondRate.model').find = async () => [];
  require('../src/models/colorstoneRate.model').find = async () => [];
  require('../src/services/scanBilling.service').billCompletedScan = async ({ scan }) => {
    bills.push(scan.scanId);
    return { totalScanCharge: 1, billedAt: new Date() };
  };
  openaiService = require('../src/services/openai.service');
  scanService = require('../src/services/scan.service');
  ocrPreprocessCache = require('../src/services/ocrPreprocess.cache');
}

// A camera-crop tag, upright: no magnified part is cut, so one read per pipeline.
let fileCount = 0;
const tagImage = async () => {
  const svg = `
  <svg width="1200" height="750" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="750" fill="#ffffff"/>
    <g font-family="Arial" font-size="64" font-weight="700" fill="#1a1a1a">
      <text x="80" y="150">GR WT 8.208</text>
      <text x="80" y="300">NET WT 8.100</text>
      <text x="80" y="450">ST NO GR10286</text>
    </g>
  </svg>`;
  fileCount += 1;
  const file = path.join(tmpDir, `tag-${fileCount}.jpg`);
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(file);
  return file;
};

const readsSince = (mark) => api.requests.slice(mark).filter((r) => r.kind.startsWith('read'));
const rotationSince = (mark) => api.requests.slice(mark).find((r) => r.kind === 'print-rotation');

test('the reads start while the question is answered; an answer of 0 keeps them', async () => {
  const mark = api.requests.length;
  const logMark = logs.length;
  api.rotate = 0;
  api.holdRotation = true;
  const file = await tagImage();
  const pipeline = openaiService.analyzeImages(file, null, 'GOLD', 'SINGLE_SIDE', {}, null);
  let result;
  try {
    assert.ok(await waitFor(() => readsSince(mark).length === 1 && rotationSince(mark)), 'the read went out');
    assert.equal(rotationSince(mark).answered, false, 'before the orientation answer came');
  } finally {
    releaseRotation();
    result = await pipeline;
  }

  assert.equal(readsSince(mark).length, 1, 'nothing read twice');
  assert.ok(readsSince(mark)[0].answered && !readsSince(mark)[0].aborted);
  assert.equal(result.structuredData.grossWeight.value, '8.208');
  assert.equal(result.timing.rotationReread, false);
  assert.ok(result.timing.rotationMs >= 0);
  assert.ok(!Object.keys(result).includes('timing'), 'the timing is not part of the reading');
  assert.ok(!logs.slice(logMark).some((entry) => entry.tag === '[PRINT_ROTATION_REREAD]'));
  assert.deepEqual(failureLogsSince(logMark), []);
});

test('a tag the other way up aborts the upright read and reads the turned views; the aborted read is not billed', async () => {
  const mark = api.requests.length;
  const logMark = logs.length;
  api.rotate = 180;
  api.holdRotation = true;
  // The upright read is still out when the answer comes.
  api.holdReads = true;
  const file = await tagImage();
  const pipeline = openaiService.analyzeImages(file, null, 'GOLD', 'SINGLE_SIDE', {}, null);
  let upright;
  let result;
  try {
    assert.ok(await waitFor(() => readsSince(mark).length === 1 && rotationSince(mark)));
    upright = readsSince(mark)[0];
    releaseRotation();
    assert.ok(await waitFor(() => upright.aborted), 'the upright read was cancelled at the API');
  } finally {
    releaseRotation();
    releaseReads();
    result = await pipeline;
  }

  const reads = readsSince(mark);
  assert.equal(reads.length, 2);
  assert.ok(reads[1].answered);
  assert.notEqual(reads[1].image, upright.image, 'the second read saw the turned image');
  assert.equal(result.billingMeta.promptTokens, 1000, 'only the read that was kept is counted');
  assert.equal(result.timing.rotationReread, true);
  assert.ok(logs.slice(logMark).some((entry) => entry.tag === '[PRINT_ROTATION_REREAD]'));
  assert.deepEqual(failureLogsSince(logMark), []);
  api.rotate = 0;
});

test('an answer already in (asked at upload) sends the right read straight away', async () => {
  for (const rotate of [0, 180]) {
    api.rotate = rotate;
    const file = await tagImage();
    const scanId = `warm-${rotate}`;
    ocrPreprocessCache.beginWarm(scanId, 'front', file, { businessId: 'b1', userId: null }).commit();
    const staged = ocrPreprocessCache.takePreprocessedStaged(scanId, 'front', file);
    assert.equal(await staged.rotation, rotate);
    const mark = api.requests.length;

    const result = await openaiService.analyzeImages(file, null, 'GOLD', 'SINGLE_SIDE', {}, null, {
      frontStaged: staged,
    });
    const reads = readsSince(mark);
    assert.equal(reads.length, 1, `one read for an answer of ${rotate}`);
    assert.ok(!reads[0].aborted);
    assert.equal(rotationSince(mark), undefined, 'the question is not asked again');
    assert.equal(result.timing.rotationReread, false);
    assert.equal(reads[0].image.split(',')[1], (await staged.final).full, 'the final views were read');
  }
  api.rotate = 0;
});

test('an unclear answer (the question itself failed) reads the photo as it arrived, as before', async () => {
  const mark = api.requests.length;
  const logMark = logs.length;
  api.failRotation = true;
  try {
    const file = await tagImage();
    const result = await openaiService.analyzeImages(file, null, 'GOLD', 'SINGLE_SIDE', {}, null);
    assert.equal(readsSince(mark).length, 1);
    assert.equal(result.structuredData.grossWeight.value, '8.208');
    assert.equal(result.timing.rotationReread, false);
    assert.ok(logs.slice(logMark).some((entry) => entry.tag === '[PRINT_ROTATION_FAILED]'));
  } finally {
    api.failRotation = false;
  }
});

test('the speculative read at upload does the same: a turned tag is read again, written and billed once', async () => {
  const OWNER = { userId: 'u-rot', businessId: 'b-rot', role: 'OWNER' };
  const mark = api.requests.length;
  const logMark = logs.length;
  api.rotate = 180;
  api.holdRotation = true;
  api.holdReads = true;
  const created = await scanService.createScan('GOLD', 'SINGLE_SIDE', OWNER);
  const file = await tagImage();
  let upright;
  try {
    await scanService.saveImage(created.scanId, file, 'front', OWNER, { speculate: true, businessId: 'b-rot' });
    assert.ok(
      await waitFor(() => readsSince(mark).length === 1 && rotationSince(mark)),
      'the speculative read started on the upright views',
    );
    upright = readsSince(mark)[0];
    releaseRotation();
    assert.ok(await waitFor(() => upright.aborted), 'the upright read was cancelled at the API');
  } finally {
    releaseRotation();
    releaseReads();
  }
  assert.ok(await waitFor(() => readsSince(mark).length === 2 && readsSince(mark)[1].answered));

  const analyzed = await scanService.analyzeScan(created.scanId, {}, 'b-rot', OWNER);
  await sleep(30);
  assert.equal(analyzed.status, 'ANALYSIS_COMPLETED');
  assert.equal(readsSince(mark).length, 2, 'analyze took the speculative read, nothing more was sent');
  assert.equal(analyzed.analysisResult.billingMeta.promptTokens, 1000);
  assert.deepEqual(bills.filter((id) => id === created.scanId), [created.scanId]);
  assert.ok(logs.slice(logMark).some((entry) => entry.tag === '[SPECULATIVE_ANALYSIS_USED]'));
  assert.deepEqual(failureLogsSince(logMark), []);
  api.rotate = 0;
});

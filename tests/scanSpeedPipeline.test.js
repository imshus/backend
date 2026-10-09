/**
 * The scan pipeline's timing work, end to end against a fake OpenAI endpoint
 * (as analyzeImagesConsensus.test.js does: no real model call) with the scan
 * record stood in for:
 *  - an upload's warm-up starts before the scan-record round trips, and is
 *    aborted and never published when the upload fails its access check;
 *  - a speculative analysis a newer upload supersedes is aborted at the API,
 *    writes nothing, bills nothing and logs no failure, and analyze never
 *    waits on one it cannot use; one that had already finished is logged as
 *    discarded, not cancelled;
 *  - the speculative read is collected by analyze whether it was one read
 *    (no part cut: the two reads would have been identical) or two, under
 *    the speculative matching on images + prompt text, with the labour
 *    setting applied by rule;
 *  - a refused speed parameter is left out for the model that refused it
 *    only, and only until the refusal expires.
 */
process.env.USE_MEMORY_STORE = 'true';
// The settle delay before a speculative analysis calls the model.
process.env.SPECULATIVE_SETTLE_MS = '30';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpscan-speed-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 15_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return false;
    await sleep(5);
  }
  return true;
};

// ── The fake API ────────────────────────────────────────────────────────────
// Every request is kept with whether it was answered or cancelled by the
// client. Kinds listed in `hold` are left unanswered until the client aborts.
const api = { requests: [], hold: new Set(), labour: '' };

const kindOf = (body) => {
  const user = body.messages.find((m) => m.role === 'user');
  const texts = (Array.isArray(user?.content) ? user.content : [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (texts.startsWith('Which way up')) return 'print-rotation';
  if (texts.startsWith('Where is the printed tag')) return 'tag-box';
  if (texts.startsWith('Two independent readings')) return 'adjudicate';
  if (texts.includes('quarter')) return 'read-a';
  if (texts.includes('third')) return 'read-b';
  return 'read-plain';
};

const readAnswer = {
  provider: 'openai-test',
  rawText: { merged: 'DIA WT .54 GR WT 8.208 NET WT 8.100 ST NO GR10286' },
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
        weight: ['.54', 88],
        pieces: ['', 0],
        rate: ['', 0],
        quality: ['FG SI', 90],
        color: ['FG', 90],
        clarity: ['SI', 90],
      },
    ],
    colorstones: [],
  },
  unknownFields: [],
  clarificationRequired: false,
  overallConfidence: 90,
};

const answerFor = (kind, body) => {
  if (kind === 'print-rotation') return { status: 200, json: { rotate: 0 } };
  if (kind === 'tag-box') {
    // "model-x" refuses the priority tier; everything else takes it.
    if (body.model === 'model-x' && body.service_tier) {
      return {
        status: 400,
        json: {
          error: {
            message: "Unsupported parameter: 'service_tier' is not supported with this model.",
            type: 'invalid_request_error',
            param: 'service_tier',
            code: 'unsupported_parameter',
          },
        },
      };
    }
    return { status: 200, json: { found: false } };
  }
  if (kind === 'adjudicate') return { status: 200, json: { answers: {} } };
  const labour = [api.labour, api.labour ? 90 : 0];
  return { status: 200, json: { ...readAnswer, structuredData: { ...readAnswer.structuredData, labour } } };
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
      const entry = { kind: kindOf(body), model: body.model, body, answered: false, aborted: false };
      api.requests.push(entry);
      res.on('close', () => {
        if (!entry.answered) entry.aborted = true;
      });
      const respond = () => {
        entry.answered = true;
        const { status, json } = answerFor(entry.kind, body);
        res.writeHead(status, { 'content-type': 'application/json' });
        if (status !== 200) {
          res.end(JSON.stringify(json));
          return;
        }
        res.end(
          JSON.stringify({
            id: 'fake',
            choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(json) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
          }),
        );
      };
      const held = api.hold.has(entry.kind) || (entry.kind.startsWith('read') && api.hold.has('read'));
      if (!held) respond();
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

// ── Logs, the scan record and billing, stood in for ─────────────────────────
const logs = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level];
  console[level] = (...args) => {
    logs.push({ level, tag: String(args[0]) });
    // Failures still reach the test output; the routine lines do not.
    if (level === 'warn' || level === 'error') original.apply(console, args);
  };
}
const failureLogsSince = (mark) =>
  logs
    .slice(mark)
    .map((entry) => entry.tag)
    .filter((tag) => /FAILED|OpenAI Error|RETRY_PLAIN/.test(tag));

const store = new Map();
const writes = [];
const bills = [];
const hooks = { getScan: null };
const clone = (value) => JSON.parse(JSON.stringify(value));

let scanService;
let openaiService;
let ocrPreprocessCache;
function load() {
  const redisService = require('../src/services/redis.service');
  redisService.getPromptCustomizations = async () => null;
  // The shop's own grades for the prompt: none, without a database.
  require('../src/models/diamondRate.model').find = async () => [];
  require('../src/models/colorstoneRate.model').find = async () => [];
  redisService.getScan = async (scanId) => {
    if (hooks.getScan) await hooks.getScan(scanId);
    const scan = store.get(scanId);
    return scan ? clone(scan) : null;
  };
  redisService.updateScanStatus = async (scanId, status, extraData = {}) => {
    const scan = store.get(scanId);
    if (!scan) throw new Error('Scan not found');
    const updated = { ...scan, ...extraData, status, updatedAt: new Date().toISOString() };
    store.set(scanId, updated);
    writes.push({ scanId, status, extraData });
    return clone(updated);
  };
  const scanBillingService = require('../src/services/scanBilling.service');
  scanBillingService.billCompletedScan = async ({ scan }) => {
    bills.push(scan.scanId);
    return { totalScanCharge: 1, billedAt: new Date() };
  };
  scanService = require('../src/services/scan.service');
  openaiService = require('../src/services/openai.service');
  ocrPreprocessCache = require('../src/services/ocrPreprocess.cache');
}

const OWNER = { userId: 'u1', businessId: 'b1', role: 'OWNER' };
const newScan = (scanId) =>
  store.set(scanId, {
    scanId,
    status: 'WAITING_FOR_SCAN',
    jewelleryType: 'DIAMOND',
    scanType: 'BOTH_SIDES',
    ownerUserId: 'u1',
    businessId: 'b1',
  });

// One file per call: libvips maps an input file, and Windows will not let a
// mapped file be rewritten. A camera-crop size: no magnified part is cut, so
// each pipeline sends one read, and the suite's other files are not starved
// of CPU while it runs.
let fileCount = 0;
const tagImage = async () => {
  const svg = `
  <svg width="1200" height="750" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="750" fill="#ffffff"/>
    <g font-family="Arial" font-size="64" font-weight="700" fill="#1a1a1a">
      <text x="80" y="150">DIA WT .54</text>
      <text x="80" y="300">GR WT 8.208</text>
      <text x="80" y="450">NET WT 8.100</text>
      <text x="80" y="600">ST NO GR10286</text>
    </g>
  </svg>`;
  fileCount += 1;
  const file = path.join(tmpDir, `tag-${fileCount}.jpg`);
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(file);
  return file;
};

// A phone-photo size: magnified parts are cut, so a pipeline sends two reads.
const largeTagImage = async () => {
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
  fileCount += 1;
  const file = path.join(tmpDir, `large-tag-${fileCount}.jpg`);
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(file);
  return file;
};

/** Settles analyzeScan's background billing before anything is counted. */
const settleBackground = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await sleep(30);
};

// ── Upload warm-up ──────────────────────────────────────────────────────────

test('the upload warm-up starts before the scan-record round trips', async () => {
  const scanId = 'scan-warm-1';
  newScan(scanId);
  const file = await tagImage();
  const before = api.requests.length;
  let orientationCallBeforeRecord = false;
  // The record answers only once this upload's orientation call is already
  // at the API, which can only happen when the warm-up did not wait for it.
  hooks.getScan = async () => {
    orientationCallBeforeRecord = await waitFor(() =>
      api.requests.slice(before).some((r) => r.kind === 'print-rotation'),
    );
  };
  try {
    await scanService.saveImage(scanId, file, 'front', OWNER, {});
  } finally {
    hooks.getScan = null;
  }
  assert.equal(orientationCallBeforeRecord, true);
  const views = await ocrPreprocessCache.takePreprocessed(scanId, 'front', file);
  assert.ok(views?.full, 'the committed views are there for analyze');
  assert.equal(ocrPreprocessCache.takePreprocessed('another-scan', 'front', file), null);
});

test('an upload that fails its access check has its warm-up aborted and never published', async () => {
  const scanId = 'scan-warm-2';
  newScan(scanId);
  // The owner's own upload first: a stranger's attempt must not touch it.
  const ownFile = await tagImage();
  await scanService.saveImage(scanId, ownFile, 'front', OWNER, {});
  const ownViews = ocrPreprocessCache.takePreprocessed(scanId, 'front', ownFile);
  assert.ok(ownViews);
  await ownViews;

  const strangerFile = await tagImage();
  const before = api.requests.length;
  const logMark = logs.length;
  api.hold.add('print-rotation');
  // The record answers once the stranger's orientation call is in flight.
  hooks.getScan = async () => {
    await waitFor(() => api.requests.slice(before).some((r) => r.kind === 'print-rotation'));
  };
  try {
    await assert.rejects(
      scanService.saveImage(scanId, strangerFile, 'front', { userId: 'u2', businessId: 'b1' }, { speculate: true }),
      (error) => error.statusCode === 403,
    );
  } finally {
    hooks.getScan = null;
  }
  const probe = api.requests.slice(before).find((r) => r.kind === 'print-rotation');
  assert.ok(probe, 'the warm-up had started before the access check');
  assert.ok(await waitFor(() => probe.aborted, 10_000), 'its orientation call was cancelled');
  api.hold.delete('print-rotation');

  assert.equal(ocrPreprocessCache.takePreprocessed(scanId, 'front', strangerFile), null);
  assert.equal(ocrPreprocessCache.takePreprocessed(scanId, 'front', ownFile), ownViews, "the owner's views are untouched");
  assert.equal(store.get(scanId).frontImagePath, ownFile);
  // Its speculation never reached the model either.
  await sleep(120);
  assert.equal(api.requests.slice(before).filter((r) => r.kind.startsWith('read')).length, 0);
  assert.deepEqual(failureLogsSince(logMark), []);
});

// ── Speculative analysis ────────────────────────────────────────────────────

test('a newer upload aborts the speculative analysis in flight; it writes and bills nothing', async () => {
  const scanId = 'scan-spec-1';
  newScan(scanId);
  const front = await tagImage();
  const back = await tagImage();
  const before = api.requests.length;
  const writeMark = writes.length;
  const logMark = logs.length;

  api.hold.add('read');
  await scanService.saveImage(scanId, front, 'front', OWNER, { speculate: true, businessId: 'b1' });
  // The front-only speculation sends its read, which the API holds.
  assert.ok(await waitFor(() => api.requests.slice(before).filter((r) => r.kind.startsWith('read')).length >= 1));
  const stale = api.requests.slice(before).filter((r) => r.kind.startsWith('read'));
  api.hold.delete('read');

  await scanService.saveImage(scanId, back, 'back', OWNER, { speculate: true, businessId: 'b1' });
  assert.ok(await waitFor(() => stale.every((r) => r.aborted), 10_000), 'the superseded reads were cancelled');

  const result = await scanService.analyzeScan(scanId, {}, 'b1', OWNER);
  await settleBackground();

  assert.equal(result.status, 'ANALYSIS_COMPLETED');
  // One result written, by the analyze request, and billed once.
  const resultWrites = writes.slice(writeMark).filter((w) => w.extraData.analysisResult);
  assert.equal(resultWrites.length, 1);
  assert.ok(!writes.slice(writeMark).some((w) => w.status === 'ANALYSIS_FAILED'));
  assert.deepEqual(bills.filter((id) => id === scanId), [scanId]);
  // The reading that was used saw both sides.
  const reads = api.requests.slice(before).filter((r) => r.kind.startsWith('read'));
  const seesBack = (read) =>
    read.body.messages[1].content.some((c) => c.type === 'text' && /Back of the tag/.test(c.text));
  const answeredReads = reads.filter((r) => r.answered);
  assert.ok(answeredReads.length >= 1);
  assert.ok(answeredReads.every(seesBack));
  // The cancelled front-only pipeline sent its one read and nothing after it:
  // no retry, and nothing was logged as a failure.
  assert.deepEqual(reads.filter((r) => !seesBack(r)), stale);
  assert.deepEqual(failureLogsSince(logMark), []);
  assert.ok(logs.slice(logMark).some((entry) => entry.tag === '[SPECULATIVE_ANALYSIS_CANCELLED]'));
});

test('a superseded speculation that had already finished is logged as discarded, not cancelled', async () => {
  const scanId = 'scan-spec-3';
  newScan(scanId);
  const front = await tagImage();
  const back = await tagImage();
  const before = api.requests.length;
  const logMark = logs.length;

  await scanService.saveImage(scanId, front, 'front', OWNER, { speculate: true, businessId: 'b1' });
  // The front-only speculation runs to the end: its read is answered and the
  // pipeline returns (its last log line, then only synchronous work).
  assert.ok(
    await waitFor(() => logs.slice(logMark).some((entry) => entry.tag.startsWith('[TIMING] openai_call_ms'))),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const frontReads = api.requests.slice(before).filter((r) => r.kind.startsWith('read'));
  assert.ok(frontReads.length >= 1 && frontReads.every((r) => r.answered));

  const backMark = logs.length;
  await scanService.saveImage(scanId, back, 'back', OWNER, { speculate: true, businessId: 'b1' });
  const tags = logs.slice(backMark).map((entry) => entry.tag);
  assert.ok(tags.includes('[SPECULATIVE_ANALYSIS_DISCARDED]'), 'the finished pipeline is reported as discarded');
  assert.ok(!tags.includes('[SPECULATIVE_ANALYSIS_CANCELLED]'), 'no saving is claimed for calls already paid for');

  const result = await scanService.analyzeScan(scanId, {}, 'b1', OWNER);
  await settleBackground();
  assert.equal(result.status, 'ANALYSIS_COMPLETED');
  assert.deepEqual(bills.filter((id) => id === scanId), [scanId]);
  assert.deepEqual(failureLogsSince(logMark), []);
});

test('analyze cancels a speculative analysis it cannot use instead of waiting on it', async () => {
  const scanId = 'scan-spec-2';
  newScan(scanId);
  const front = await tagImage();
  const before = api.requests.length;
  const writeMark = writes.length;
  const logMark = logs.length;

  api.hold.add('read');
  await scanService.saveImage(scanId, front, 'front', OWNER, { speculate: true, businessId: 'b1' });
  assert.ok(await waitFor(() => api.requests.slice(before).filter((r) => r.kind.startsWith('read')).length >= 1));
  const held = api.requests.slice(before).filter((r) => r.kind.startsWith('read'));
  api.hold.delete('read');

  // A different jewellery type is a different prompt: the speculation's
  // result cannot be used. (A setting the prompt does not read, or the labour
  // setting, would not make it unusable: the speculation is matched on the
  // images and the prompt text.) The held reads are never answered, so
  // waiting on them would hang here.
  store.set(scanId, { ...store.get(scanId), jewelleryType: 'GOLD' });
  let guard;
  const result = await Promise.race([
    scanService.analyzeScan(scanId, {}, 'b1', OWNER),
    new Promise((resolve, reject) => {
      guard = setTimeout(() => reject(new Error('analyze waited on the cancelled speculation')), 30_000);
    }),
  ]).finally(() => clearTimeout(guard));
  await settleBackground();

  assert.equal(result.status, 'ANALYSIS_COMPLETED');
  assert.ok(
    await waitFor(() => held.every((r) => r.aborted), 10_000),
    'the unusable speculation was cancelled',
  );
  assert.equal(writes.slice(writeMark).filter((w) => w.extraData.analysisResult).length, 1);
  assert.deepEqual(bills.filter((id) => id === scanId), [scanId]);
  assert.deepEqual(failureLogsSince(logMark), []);
});

// ── The speculative read, one read or two, collected by analyze ─────────────

const readsSince = (mark) => api.requests.slice(mark).filter((r) => r.kind.startsWith('read'));
const promptTextOf = (read) =>
  read.body.messages[1].content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
/** Uploads the front under `speculate` and waits for that pipeline to finish. */
const speculateFront = async (scanId, file, logMark) => {
  await scanService.saveImage(scanId, file, 'front', OWNER, { speculate: true, businessId: 'b1' });
  assert.ok(
    await waitFor(() => logs.slice(logMark).some((entry) => entry.tag.startsWith('[TIMING] openai_call_ms'))),
    'the speculative pipeline finished',
  );
  await new Promise((resolve) => setImmediate(resolve));
};

test('a speculative SINGLE read is collected: settings the prompt never reads, labour by rule, one read in all', async () => {
  const scanId = 'scan-spec-4';
  newScan(scanId);
  const front = await tagImage();
  const before = api.requests.length;
  const writeMark = writes.length;
  const logMark = logs.length;
  api.labour = '12';
  try {
    await speculateFront(scanId, front, logMark);
    const result = await scanService.analyzeScan(
      scanId,
      { labourChargePreference: 'PERCENTAGE', showRtgs: true },
      'b1',
      OWNER,
    );
    await settleBackground();

    assert.equal(readsSince(before).length, 1, 'the one speculative read, and nothing on the wait');
    assert.equal(result.analysisResult.consensus.mode, 'single-identical');
    assert.equal(result.analysisResult.structuredData.labour.value, '12%', 'the labour setting applied by rule');
    assert.ok(logs.slice(logMark).some((entry) => entry.tag === '[SPECULATIVE_ANALYSIS_USED]'));
    assert.equal(writes.slice(writeMark).filter((w) => w.extraData.analysisResult).length, 1);
    assert.deepEqual(bills.filter((id) => id === scanId), [scanId]);
    assert.deepEqual(failureLogsSince(logMark), []);
  } finally {
    api.labour = '';
  }
});

test('a speculative DOUBLE read (parts cut) is collected the same way: two reads in all, none on the wait', async () => {
  const scanId = 'scan-spec-5';
  newScan(scanId);
  const front = await largeTagImage();
  const before = api.requests.length;
  const logMark = logs.length;

  await speculateFront(scanId, front, logMark);
  const result = await scanService.analyzeScan(scanId, { labourChargePreference: 'AMOUNT' }, 'b1', OWNER);
  await settleBackground();

  assert.deepEqual(readsSince(before).map((r) => r.kind).sort(), ['read-a', 'read-b']);
  assert.ok(readsSince(before).every((r) => r.answered));
  assert.equal(result.analysisResult.consensus.mode, 'double');
  assert.ok(logs.slice(logMark).some((entry) => entry.tag === '[SPECULATIVE_ANALYSIS_USED]'));
  assert.deepEqual(bills.filter((id) => id === scanId), [scanId]);
  assert.deepEqual(failureLogsSince(logMark), []);
});

test('a speculative single read whose labour the rule cannot rewrite is read again once, with the setting', async () => {
  const scanId = 'scan-spec-6';
  newScan(scanId);
  const front = await tagImage();
  const before = api.requests.length;
  const logMark = logs.length;
  api.labour = '12% + 300';
  try {
    await speculateFront(scanId, front, logMark);
    const result = await scanService.analyzeScan(scanId, { labourChargePreference: 'AMOUNT' }, 'b1', OWNER);
    await settleBackground();

    const reads = readsSince(before);
    assert.equal(reads.length, 2, 'the speculative read, then one fresh read');
    assert.notEqual(promptTextOf(reads[1]), promptTextOf(reads[0]), 'the fresh read carries the setting');
    assert.equal(result.analysisResult.consensus.mode, 'single-identical');
    assert.equal(result.analysisResult.structuredData.labour.value, '12% + 300');
    const tags = logs.slice(logMark).map((entry) => entry.tag);
    assert.ok(tags.includes('[SPECULATIVE_ANALYSIS_SKIPPED]'));
    assert.ok(!tags.includes('[SPECULATIVE_ANALYSIS_CANCELLED]'), 'a finished read is not reported as a saving');
    assert.deepEqual(bills.filter((id) => id === scanId), [scanId]);
    assert.deepEqual(failureLogsSince(logMark), []);
  } finally {
    api.labour = '';
  }
});

// ── Refused speed parameters ────────────────────────────────────────────────

test('a refused speed parameter is left out for that model only, and only until it expires', async () => {
  // Long enough that nothing expires mid-test however loaded the machine is;
  // expiry is driven through the clock arguments, never by sleeping.
  const ttlMs = 60_000;
  process.env.OPENAI_REFUSED_PARAM_TTL_MS = String(ttlMs);
  const { isSpeedParamRefused, markSpeedParamsRefused } = openaiService._internal;
  const thumbnail = (
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).jpeg().toBuffer()
  ).toString('base64');
  const tagBoxWith = async (model) => {
    process.env.OPENAI_TAG_BOX_MODEL = model;
    const before = api.requests.length;
    await openaiService.detectTagBox(thumbnail, { businessId: 'b1' });
    return api.requests.slice(before).filter((r) => r.kind === 'tag-box');
  };
  const tiers = (sent) => sent.map((r) => r.body.service_tier ?? null);
  const logMark = logs.length;
  try {
    let sent = await tagBoxWith('model-x');
    assert.deepEqual(tiers(sent), ['priority', null], 'refused, then retried without it');

    sent = await tagBoxWith('model-x');
    assert.deepEqual(tiers(sent), [null], 'not offered again to the model that refused it');
    assert.equal(sent[0].body.reasoning_effort, 'none', 'what was not refused is still sent');

    sent = await tagBoxWith('model-y');
    assert.deepEqual(tiers(sent), ['priority'], 'another model still gets it');

    assert.equal(isSpeedParamRefused('model-x', 'service_tier'), true);
    assert.equal(isSpeedParamRefused('model-y', 'service_tier'), false);

    // Expire model-x's refusal by backdating it a full TTL into the past (the
    // same record the 400 wrote, now already over), then call again.
    markSpeedParamsRefused('model-x', ['service_tier'], { now: Date.now() - ttlMs - 1 });
    sent = await tagBoxWith('model-x');
    assert.deepEqual(tiers(sent), ['priority', null], 'offered again once the refusal expired');

    const dropped = logs
      .slice(logMark)
      .filter((entry) => entry.tag === '[OPENAI_SPEED_PARAM_DROPPED]');
    assert.equal(dropped.length, 2, 'logged once each time it was dropped');

    // The expiry boundary itself, on a fixed clock.
    const t = Date.now();
    markSpeedParamsRefused('model-z', ['service_tier'], { now: t });
    assert.equal(isSpeedParamRefused('model-z', 'service_tier', t + ttlMs - 1), true);
    assert.equal(isSpeedParamRefused('model-w', 'service_tier', t + ttlMs - 1), false, 'per model');
    assert.equal(isSpeedParamRefused('model-z', 'service_tier', t + ttlMs + 1), false);
  } finally {
    // Nothing this test refused outlives it.
    for (const model of ['model-x', 'model-y', 'model-z']) {
      isSpeedParamRefused(model, 'service_tier', Infinity);
    }
    delete process.env.OPENAI_REFUSED_PARAM_TTL_MS;
    delete process.env.OPENAI_TAG_BOX_MODEL;
  }
});

test('the reader defaults to gpt-5.6-luna', () => {
  const saved = process.env.OPENAI_MODEL;
  delete process.env.OPENAI_MODEL;
  try {
    assert.equal(openaiService._internal.resolveModelSettings().model, 'gpt-5.6-luna');
  } finally {
    if (saved !== undefined) process.env.OPENAI_MODEL = saved;
  }
});

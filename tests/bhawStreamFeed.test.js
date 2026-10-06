/**
 * The server's rate board comes off the owner's 3-minute stream (server-sent
 * events). No network here: axios is stubbed and the stream is a fake.
 *
 * Pins the framing (comments and heartbeats are liveness, never rates), the
 * payload shapes ({ sources } and the old bare array, ok: false dropped), the
 * one-shot read, freshness until next_fetch_at + 90 s, and the long-lived
 * subscription's reconnects.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { PassThrough } = require('stream');

const {
  createSseParser,
  parseSseText,
  snapshotPayload,
} = require('../src/services/sseFrames');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'bhaw.service.js');
const SERVICE_DIR = path.dirname(SERVICE);

// Every axios.get the service makes lands here; each test sets `respond`.
const calls = [];
let respond = async () => ({ data: [] });

const axiosResolved = Module._resolveFilename('axios', {
  id: SERVICE, filename: SERVICE, paths: Module._nodeModulePaths(SERVICE_DIR),
});
require.cache[axiosResolved] = {
  id: axiosResolved, filename: axiosResolved, loaded: true,
  exports: {
    get: async (url, options) => {
      calls.push({ url, options });
      return respond(url, options);
    },
  },
};

const bhawService = require(SERVICE);
const callsAtRequire = calls.length;

const NEAR_MONTH = 151920;
const JMD_DEC = 154261;

const house = (source, sell, extra = {}) => ({
  source,
  name: source,
  cash_bhaw: '-3000',
  rtgs_bhaw: '1900',
  rows: [{ label: 'Gold Future MCX', buy: String(sell - 20), sell: String(sell) }],
  ok: true,
  ...extra,
});

const snapshotAt = (fetchedMs, sources) => ({
  fetched_at: new Date(fetchedMs).toISOString(),
  next_fetch_at: new Date(fetchedMs + 180_000).toISOString(),
  errors: [],
  sources,
});

const fourHouses = () => [
  house('jmd_patil', JMD_DEC),
  house('mega_bullion', NEAR_MONTH),
  house('shri_sai', NEAR_MONTH),
  house('shri_ganesh', NEAR_MONTH),
];

const realNow = Date.now;
let clock = realNow();
const setClock = (ms) => { clock = ms; };

const reset = () => {
  calls.length = 0;
  respond = async () => ({ data: [] });
  bhawService.__internal.resetCache();
};

test.beforeEach(() => {
  reset();
  Date.now = () => clock;
});

test.afterEach(() => {
  Date.now = realNow;
  bhawService.stopKeepWarm();
});

// ---- framing --------------------------------------------------------------

test('frames: comments are skipped, a blank line dispatches, unnamed events are messages', () => {
  const events = parseSseText(': ping\n\ndata: [1]\n\n: another comment\nid: 7\nretry: 100\ndata: [2]\n\n');
  assert.deepEqual(events, [
    { event: 'message', data: '[1]' },
    { event: 'message', data: '[2]' },
  ]);
});

test('frames: heartbeat events are named and never read as rates, even when they look like a board', () => {
  const text = 'event: heartbeat\ndata: {"type":"heartbeat","at":"2026-10-06T17:50:42+0530"}\n\n'
    + 'event: heartbeat\ndata: [{"source":"jmd_patil","rows":[]}]\n\n'
    + 'event: message\ndata: [{"source":"jmd_patil","rows":[]}]\n\n';
  const events = parseSseText(text);
  assert.equal(events.length, 3);
  assert.equal(events[0].event, 'heartbeat');
  assert.equal(snapshotPayload(events[0]), null);
  assert.equal(snapshotPayload(events[1]), null, 'a heartbeat is liveness only, whatever its data');
  assert.deepEqual(snapshotPayload(events[2]), [{ source: 'jmd_patil', rows: [] }]);
});

test('frames: several data lines join with a newline', () => {
  const [event] = parseSseText('data: {"sources":\ndata: []}\n\n');
  assert.equal(event.data, '{"sources":\n[]}');
  assert.deepEqual(snapshotPayload(event), { sources: [] });
});

test('frames: CRLF line endings are read like LF', () => {
  const events = parseSseText(': ping\r\n\r\nevent: heartbeat\r\ndata: {}\r\n\r\ndata: [3]\r\n\r\n');
  assert.deepEqual(events, [
    { event: 'heartbeat', data: '{}' },
    { event: 'message', data: '[3]' },
  ]);
});

test('frames: chunks split anywhere, a multi-byte character included, still frame correctly', () => {
  const text = ': ping\n\ndata: {"sources":[{"source":"jmd_patil","name":"JMD ₹ Patil"}]}\r\n\r\n';
  const bytes = Buffer.from(text, 'utf8');
  const events = [];
  const parser = createSseParser((event) => events.push(event));
  for (let i = 0; i < bytes.length; i += 1) parser.push(bytes.subarray(i, i + 1));
  assert.equal(events.length, 1);
  assert.equal(snapshotPayload(events[0]).sources[0].name, 'JMD ₹ Patil');
});

test('frames: an event without data, or with no blank line yet, dispatches nothing', () => {
  assert.deepEqual(parseSseText('event: heartbeat\n\n'), []);
  assert.deepEqual(parseSseText('data: [1]\n'), []);
});

test('payloads: anything but an array of sources or an object with a sources array is ignored', () => {
  assert.equal(snapshotPayload({ event: 'message', data: 'not json' }), null);
  assert.equal(snapshotPayload({ event: 'message', data: '42' }), null);
  assert.equal(snapshotPayload({ event: 'message', data: '{"type":"heartbeat"}' }), null);
  assert.equal(snapshotPayload({ event: 'message', data: '{"sources":"x"}' }), null);
  assert.equal(snapshotPayload(null), null);
});

// ---- normalisation ----------------------------------------------------------

test('normalise: { sources } is unwrapped and its times kept', () => {
  const payload = {
    fetched_at: '2026-10-06T17:50:22+0530',
    next_fetch_at: '2026-10-06T17:53:22+0530',
    errors: [],
    sources: [house('jmd_patil', JMD_DEC)],
  };
  const snapshot = bhawService.normalizePayload(payload);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].source, 'jmd_patil');
  assert.equal(snapshot.fetchedAt, '2026-10-06T17:50:22+0530');
  assert.equal(snapshot.nextFetchAt, '2026-10-06T17:53:22+0530');
});

test('normalise: the old bare array is taken as it is, with no times', () => {
  const rows = [{ source: 'jmd_patil', cash_bhaw: '-3000', rtgs_bhaw: '1900' }];
  assert.deepEqual(bhawService.normalizePayload(rows), { rows, fetchedAt: null, nextFetchAt: null });
});

test('normalise: a house with ok: false is dropped; missing ok is kept', () => {
  const snapshot = bhawService.normalizePayload({
    sources: [
      house('jmd_patil', JMD_DEC, { ok: false, error: 'timeout' }),
      house('mega_bullion', NEAR_MONTH),
      { source: 'shri_sai', rows: [] },
      null,
    ],
  });
  assert.deepEqual(snapshot.rows.map((row) => row.source), ['mega_bullion', 'shri_sai']);
});

test('normalise: anything else is not a board', () => {
  assert.equal(bhawService.normalizePayload(null), null);
  assert.equal(bhawService.normalizePayload({ type: 'heartbeat' }), null);
  assert.equal(bhawService.normalizePayload('[]'), null);
});

test('a house marked ok: false reads like one that is not live today', async () => {
  respond = async () => ({
    data: snapshotAt(clock, [
      house('jmd_patil', 160000, { ok: false }),
      house('mega_bullion', NEAR_MONTH),
      house('shri_sai', NEAR_MONTH),
    ]),
  });
  assert.equal(await bhawService.getBhawForSource('jmd_patil'), null);
  assert.equal(await bhawService.houseMcxSell('jmd_patil'), null);
  assert.equal(await bhawService.boardMcxSell(), NEAR_MONTH);
  assert.deepEqual(await bhawService.houseMcxLines(), { mega_bullion: NEAR_MONTH, shri_sai: NEAR_MONTH });
  assert.equal(await bhawService.feedStamp('jmd_patil'), 'off');
});

// ---- one-shot read ----------------------------------------------------------

test('readSnapshot reads past a ping and a heartbeat to the first snapshot, then closes the stream', async () => {
  const stream = new PassThrough();
  respond = async () => ({ data: stream });
  const payload = snapshotAt(clock, fourHouses());
  const frame = `data: ${JSON.stringify(payload)}\n\n`;

  stream.write(': ping\n\n');
  stream.write('event: heartbeat\ndata: [{"source":"jmd_patil","rows":[{"label":"Gold Future MCX","sell":"1"}]}]\n\n');
  stream.write(frame.slice(0, 40));
  stream.write(frame.slice(40));

  const snapshot = await bhawService.readSnapshot('https://feed.test/3min');
  assert.equal(snapshot.rows.length, 4);
  assert.equal(snapshot.fetchedAt, payload.fetched_at);
  assert.equal(snapshot.nextFetchAt, payload.next_fetch_at);
  assert.equal(stream.destroyed, true, 'the one-shot read hangs up after the snapshot');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://feed.test/3min');
  assert.equal(calls[0].options.responseType, 'stream');
  assert.equal(calls[0].options.headers.Accept, 'text/event-stream');
  assert.equal(calls[0].options.headers['Cache-Control'], 'no-cache');
});

test('readSnapshot rejects when the stream ends with only pings and heartbeats', async () => {
  const stream = new PassThrough();
  respond = async () => ({ data: stream });
  stream.write(': ping\n\nevent: heartbeat\ndata: {"type":"heartbeat"}\n\n');
  stream.end();
  await assert.rejects(bhawService.readSnapshot('https://feed.test/3min'), /closed before a snapshot/);
});

test('the board is priced off the stream: MCX majority, a house line, its bhaw', async () => {
  respond = async () => {
    const stream = new PassThrough();
    stream.write(': ping\n\n');
    stream.write(`data: ${JSON.stringify(snapshotAt(clock, fourHouses()))}\n\n`);
    return { data: stream };
  };
  assert.equal(await bhawService.boardMcxSell(), NEAR_MONTH);
  assert.equal(await bhawService.houseMcxSell('jmd_patil'), JMD_DEC);
  assert.deepEqual(await bhawService.getBhawForSource('jmd_patil'), {
    cashBhaw: -3000, rtgsBhaw: 1900, name: 'jmd_patil',
  });
  assert.equal(calls.length, 1, 'one read serves every lookup while it is fresh');
});

test('readers that ask at once share one read', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  respond = async () => {
    await gate;
    return { data: snapshotAt(clock, fourHouses()) };
  };
  const reads = [bhawService.boardMcxSell(), bhawService.houseMcxLines(), bhawService.prefetch()];
  release();
  const [board] = await Promise.all(reads);
  assert.equal(board, NEAR_MONTH);
  assert.equal(calls.length, 1);
});

// ---- freshness ---------------------------------------------------------------

test('a snapshot is fresh until next_fetch_at + 90 s, not the old 30 s', async () => {
  const t0 = Date.UTC(2026, 9, 6, 12, 20, 22);
  setClock(t0);
  respond = async () => ({ data: snapshotAt(t0, fourHouses()) });
  assert.equal(await bhawService.boardMcxSell(), NEAR_MONTH);
  assert.equal(calls.length, 1);

  setClock(t0 + 60_000);
  await bhawService.boardMcxSell();
  assert.equal(calls.length, 1, 'past the old 30 s TTL, still fresh');

  setClock(t0 + 180_000 + 89_000);
  await bhawService.boardMcxSell();
  assert.equal(calls.length, 1, 'inside next_fetch_at + 90 s');

  const t1 = t0 + 180_000;
  respond = async () => ({
    data: snapshotAt(t1, [house('mega_bullion', NEAR_MONTH + 300), house('shri_sai', NEAR_MONTH + 300)]),
  });
  setClock(t0 + 180_000 + 91_000);
  assert.equal(await bhawService.boardMcxSell(), NEAR_MONTH + 300);
  assert.equal(calls.length, 2, 'past next_fetch_at + 90 s it is read again');
});

test('a bare-array board keeps the 30 s TTL', async () => {
  const t0 = Date.UTC(2026, 9, 6, 12, 0, 0);
  setClock(t0);
  respond = async () => ({ data: fourHouses() });
  await bhawService.boardMcxSell();
  setClock(t0 + 29_000);
  await bhawService.boardMcxSell();
  assert.equal(calls.length, 1);
  setClock(t0 + 31_000);
  await bhawService.boardMcxSell();
  assert.equal(calls.length, 2);
});

test('a failed read keeps serving the last board', async () => {
  const t0 = Date.UTC(2026, 9, 6, 13, 0, 0);
  setClock(t0);
  respond = async () => ({ data: snapshotAt(t0, fourHouses()) });
  assert.equal(await bhawService.boardMcxSell(), NEAR_MONTH);

  setClock(t0 + 10 * 60_000);
  respond = async () => { throw new Error('connect ECONNREFUSED'); };
  assert.equal(await bhawService.boardMcxSell(), NEAR_MONTH);

  respond = async () => ({ data: { sources: [] } });
  assert.equal(await bhawService.boardMcxSell(), NEAR_MONTH, 'an empty board does not replace a real one');
});

// ---- long-lived subscription ---------------------------------------------------

/** Holds back the subscription's retry and idle timers so a test can fire them. */
const holdTimers = () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const held = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms >= 2_000) {
      const handle = { fn, ms, cleared: false, unref() { return this; } };
      held.push(handle);
      return handle;
    }
    return realSetTimeout(fn, ms, ...args);
  };
  global.clearTimeout = (handle) => {
    if (handle && held.includes(handle)) handle.cleared = true;
    else realClearTimeout(handle);
  };
  return {
    pending: (ms) => held.filter((handle) => !handle.cleared && handle.ms === ms),
    restore: () => {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    },
  };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('keep-warm: one stream, every snapshot becomes the board, reconnects back off 2 s doubling', async () => {
  const timers = holdTimers();
  try {
    const t0 = Date.UTC(2026, 9, 6, 14, 0, 0);
    setClock(t0);
    const streams = [];
    respond = async () => {
      const stream = new PassThrough();
      streams.push(stream);
      return { data: stream };
    };

    bhawService.startKeepWarm();
    bhawService.startKeepWarm();
    await tick();
    assert.equal(calls.length, 1, 'one stream, however often it is started');
    assert.equal(calls[0].options.responseType, 'stream');
    assert.equal(calls[0].options.timeout, undefined, 'no axios timeout on a long-lived body');

    streams[0].write(': ping\n\n');
    streams[0].write(`data: ${JSON.stringify(snapshotAt(t0, fourHouses()))}\n\n`);
    await tick();
    assert.equal(await bhawService.boardMcxSell(), NEAR_MONTH);

    const t1 = t0 + 180_000;
    setClock(t1);
    streams[0].write('event: heartbeat\ndata: {"type":"heartbeat"}\n\n');
    streams[0].write(`data: ${JSON.stringify(snapshotAt(t1, [house('mega_bullion', NEAR_MONTH + 500)]))}\n\n`);
    await tick();
    assert.equal(await bhawService.boardMcxSell(), NEAR_MONTH + 500, 'the next 3-minute snapshot replaces it');
    assert.equal(calls.length, 1, 'served from the subscription, no one-shot read');

    // The server hangs up: back in 2 s (a snapshot came through on that line).
    streams[0].end();
    await tick();
    const [retry1] = timers.pending(2_000);
    assert.ok(retry1, 'a reconnect is scheduled 2 s out');
    retry1.fn();
    await tick();
    assert.equal(calls.length, 2);

    // This one dies with nothing on it: the next wait doubles.
    streams[1].destroy(new Error('socket hang up'));
    await tick();
    const [retry2] = timers.pending(4_000);
    assert.ok(retry2, 'then 4 s');
    retry2.fn();
    await tick();
    assert.equal(calls.length, 3);

    // 60 s without a byte: dropped and retried.
    const idle = timers.pending(60_000);
    assert.equal(idle.length, 1, 'one idle watch on the open stream');
    idle[0].fn();
    await tick();
    assert.equal(streams[2].destroyed, true);
    assert.ok(timers.pending(8_000).length, 'then 8 s');
  } finally {
    bhawService.stopKeepWarm();
    timers.restore();
  }
});

test('keep-warm: stop closes the stream and nothing reconnects', async () => {
  const timers = holdTimers();
  try {
    const stream = new PassThrough();
    respond = async () => ({ data: stream });
    bhawService.startKeepWarm();
    await tick();
    bhawService.stopKeepWarm();
    await tick();
    assert.equal(stream.destroyed, true);
    assert.equal(timers.pending(2_000).length, 0, 'no reconnect after stop');
    assert.equal(calls.length, 1);
  } finally {
    timers.restore();
  }
});

test('requiring the service opens nothing', () => {
  assert.equal(callsAtRequire, 0, 'the require at the top of this file made no call');
});

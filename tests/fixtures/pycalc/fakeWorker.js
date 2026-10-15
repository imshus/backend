/**
 * A stand-in for calc/calc_worker.py that misbehaves on purpose, for the
 * bridge's robustness tests. It speaks the same line protocol, answers one
 * request at a time in order as the real worker does, and prices with
 * pricingMath, so it passes the bridge's probe (its first request) and then
 * behaves as `mode` says:
 *
 *   ok           answers correctly
 *   hang         never answers again
 *   malformed    answers with a line that is not JSON
 *   error        answers { ok: false }
 *   shape        answers ok with an empty breakdown
 *   crash        exits on the next request
 *   noise        writes a stray line before each correct answer
 *   wrong        answers with finalMRP off by one rupee
 *   probe-wrong  gets the probe itself wrong
 *   exit-early   writes a traceback (with its pid) to stderr and exits before
 *                reading anything
 *   slow-start   waits 400 ms before answering the probe
 *   slow         takes 100 ms over each request after the probe
 *   long-reply   answers the first request after the probe with a 6,000
 *                character line, written in two parts 50 ms apart, then
 *                answers correctly
 */
const readline = require('readline');
const { computePricing } = require('../../../src/services/pricingMath');

const mode = process.argv[2] || 'ok';
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const correct = (message) => ({ id: message.id, ok: true, breakdown: computePricing(message.inputs) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === 'exit-early') {
  process.stderr.write([
    'Traceback (most recent call last):',
    `  File "calc_worker.py", line 52, in <module> (pid ${process.pid})`,
    "ModuleNotFoundError: No module named 'pandas'",
    '',
  ].join('\n'));
  process.exit(1);
}

process.stderr.write(`fake_worker ready pid=${process.pid} mode=${mode}\n`);

let seen = 0;

async function answer(message) {
  seen += 1;
  if (seen === 1) {
    if (mode === 'probe-wrong') {
      const reply = correct(message);
      reply.breakdown.finalMRP += 1;
      write(reply);
    } else if (mode === 'slow-start') {
      await sleep(400);
      write(correct(message));
    } else {
      write(correct(message));
    }
    return;
  }
  switch (mode) {
    case 'hang':
      await new Promise(() => {});
      return;
    case 'malformed':
      process.stdout.write('this is not json\n');
      return;
    case 'error':
      write({ id: message.id, ok: false, error: 'boom' });
      return;
    case 'shape':
      write({ id: message.id, ok: true, breakdown: {} });
      return;
    case 'crash':
      process.exit(3);
      return;
    case 'noise':
      process.stdout.write('hello from a library\n');
      write(correct(message));
      return;
    case 'wrong': {
      const reply = correct(message);
      reply.breakdown.finalMRP += 1;
      write(reply);
      return;
    }
    case 'slow':
      await sleep(100);
      write(correct(message));
      return;
    case 'long-reply':
      if (seen === 2) {
        process.stdout.write('x'.repeat(3000));
        await sleep(50);
        process.stdout.write(`${'x'.repeat(3000)}\n`);
        return;
      }
      write(correct(message));
      return;
    default:
      write(correct(message));
  }
}

// One at a time, in order, like the real worker.
let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  queue = queue.then(() => answer(message));
});

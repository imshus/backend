/**
 * A stand-in for calc/calc_worker.py that misbehaves on purpose, for the
 * bridge's robustness tests. It speaks the same line protocol and prices
 * with pricingMath, so it passes the bridge's probe (its first request)
 * and then behaves as `mode` says:
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
 *   exit-early   writes to stderr and exits before reading anything
 *   slow-start   waits 400 ms before answering the probe
 */
const readline = require('readline');
const { computePricing } = require('../../../src/services/pricingMath');

const mode = process.argv[2] || 'ok';
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const correct = (message) => ({ id: message.id, ok: true, breakdown: computePricing(message.inputs) });

if (mode === 'exit-early') {
  process.stderr.write("ModuleNotFoundError: No module named 'pandas'\n");
  process.exit(1);
}

let seen = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  seen += 1;
  if (seen === 1) {
    if (mode === 'probe-wrong') {
      const reply = correct(message);
      reply.breakdown.finalMRP += 1;
      write(reply);
    } else if (mode === 'slow-start') {
      setTimeout(() => write(correct(message)), 400);
    } else {
      write(correct(message));
    }
    return;
  }
  switch (mode) {
    case 'hang':
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
    default:
      write(correct(message));
  }
});

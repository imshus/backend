/**
 * A new scan needs a wallet above the billing config's minScanBalance (0.74):
 * a wallet of 0.51 used to pass the old "above 0" check, run the scan, and
 * then fail to pay for it, so every scan after that was free.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const billingConfigService = require('../src/services/billingConfig.service');
const {
  requireScanStartBalance,
  DEFAULT_MIN_SCAN_BALANCE,
} = require('../src/middleware/license.middleware');

const original = billingConfigService.getEffectiveConfig;

async function gate(balance, config = { minScanBalance: 0.74 }) {
  billingConfigService.getEffectiveConfig = typeof config === 'function' ? config : async () => config;
  const req = { licenseContext: { wallet: { creditBalance: balance } } };
  let passed;
  await requireScanStartBalance(req, {}, (err) => { passed = err || null; });
  return passed;
}

test.after(() => {
  billingConfigService.getEffectiveConfig = original;
});

test('a wallet that cannot pay for a scan is refused at the start', async () => {
  for (const balance of [0, 0.51, 0.74]) {
    const err = await gate(balance);
    assert.ok(err, `balance ${balance} must be refused`);
    assert.equal(err.message, 'NO_CREDITS_AVAILABLE');
    assert.equal(err.statusCode, 402);
  }
});

test('a wallet above the minimum starts a scan', async () => {
  for (const balance of [0.75, 1, 12.4]) {
    assert.equal(await gate(balance), null, `balance ${balance} must pass`);
  }
});

test('the minimum comes from the billing config', async () => {
  const refused = await gate(1, { minScanBalance: 1.5 });
  assert.equal(refused.message, 'NO_CREDITS_AVAILABLE');
  assert.equal(await gate(0.2, { minScanBalance: 0 }), null, 'a minimum of 0 is the old rule');
});

test('an unreadable config falls back to 0.74', async () => {
  assert.equal(DEFAULT_MIN_SCAN_BALANCE, 0.74);
  const failing = async () => { throw new Error('db down'); };
  assert.equal((await gate(0.6, failing)).message, 'NO_CREDITS_AVAILABLE');
  assert.equal(await gate(0.8, failing), null);
  assert.equal((await gate(0.6, { minScanBalance: 'junk' })).message, 'NO_CREDITS_AVAILABLE');
});

test('no licence context is a server error, not a free pass', async () => {
  const req = {};
  let passed;
  await requireScanStartBalance(req, {}, (err) => { passed = err; });
  assert.equal(passed.message, 'LICENSE_CONTEXT_MISSING');
  assert.equal(passed.statusCode, 500);
});

test('the overview and the gate read the minimum the same way', () => {
  const { minScanBalanceOf } = billingConfigService;
  assert.equal(minScanBalanceOf({ minScanBalance: 0.74 }), 0.74);
  assert.equal(minScanBalanceOf({ minScanBalance: 1.5 }), 1.5);
  assert.equal(minScanBalanceOf({ minScanBalance: 0 }), 0, 'a 0 saved is kept');
  assert.equal(minScanBalanceOf({ minScanBalance: '0.9' }), 0.9);
  for (const bad of [-1, 'junk', null, '', undefined]) {
    assert.equal(minScanBalanceOf({ minScanBalance: bad }), 0.74, `${String(bad)} reads as 0.74`);
  }
  assert.equal(minScanBalanceOf(null), 0.74);
});

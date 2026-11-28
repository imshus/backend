const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateScanCharge } = require('../src/services/billing.service');

test('a scan with no token usage costs nothing, so it is charged nothing', () => {
  const result = calculateScanCharge({
    promptTokens: 0,
    completionTokens: 0,
    erf: 97,
  });

  assert.equal(result.inputCostUsd, 0);
  assert.equal(result.outputCostUsd, 0);
  assert.equal(result.totalUsd, 0);
  assert.equal(result.costInr, 0);
  assert.equal(result.lComp, 0);
  assert.equal(result.kComp, 0);
  assert.equal(result.aComp, 0);
  assert.equal(result.totalScanCharge, 0);
});

test('a flat line put back in billing config is still added on top', () => {
  const result = calculateScanCharge({
    promptTokens: 0,
    completionTokens: 0,
    erf: 97,
    kComp: 0.27,
    aComp: 0.15,
  });

  assert.equal(result.totalScanCharge, 0.42);
});

test('calculateScanCharge computes positive charge for token usage', () => {
  const result = calculateScanCharge({
    promptTokens: 10000,
    completionTokens: 5000,
    erf: 97,
    inputTokenPricePerMillionUsd: 0.2,
    outputTokenPricePerMillionUsd: 1.0,
  });

  assert.ok(result.totalUsd > 0);
  assert.ok(result.lComp > 0);
  assert.equal(result.totalScanCharge, result.lComp);
});

test('tokens are costed at the priority rate: $0.20 in, $1.00 out per million', () => {
  const result = calculateScanCharge({
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    erf: 1,
    kComp: 0,
    aComp: 0,
    marginMultiplier: 1,
  });

  assert.equal(result.inputCostUsd, 0.2);
  assert.equal(result.outputCostUsd, 1);
  assert.equal(result.totalUsd, 1.2);
});

test('the shop is charged exactly double what the scan cost, and nothing else', () => {
  const result = calculateScanCharge({
    promptTokens: 6000,
    completionTokens: 1500,
    erf: 97,
  });

  // 6000/1M x $0.20 + 1500/1M x $1.00 = $0.0027; x 97 = Rs 0.26 the scan cost.
  assert.equal(result.totalUsd, 0.0027);
  assert.equal(result.costInr, 0.26);
  assert.equal(result.marginMultiplier, 2);
  assert.equal(result.lComp, 0.52);
  assert.equal(result.kComp, 0);
  assert.equal(result.aComp, 0);
  assert.equal(result.totalScanCharge, 0.52);
});

test('the margin is worked out from the full cost, not the rounded rupee figure', () => {
  const result = calculateScanCharge({
    promptTokens: 3865,
    completionTokens: 0,
    erf: 97,
  });

  // The cost is Rs 0.074981, which the record rounds to 0.07. Doubling that
  // rounded figure would charge 0.14; doubling the cost itself charges 0.15.
  assert.equal(result.costInr, 0.07);
  assert.equal(result.lComp, 0.15);
  assert.equal(result.totalScanCharge, 0.15);
});

test('a config written before the margin existed still bills at double', () => {
  const result = calculateScanCharge({
    promptTokens: 6000,
    completionTokens: 1500,
    erf: 97,
    marginMultiplier: undefined,
  });

  assert.equal(result.marginMultiplier, 2);
  assert.equal(result.lComp, 0.52);
});

test('a multiplier set in billing config overrides the default', () => {
  const result = calculateScanCharge({
    promptTokens: 6000,
    completionTokens: 1500,
    erf: 97,
    marginMultiplier: 3,
  });

  assert.equal(result.marginMultiplier, 3);
  assert.equal(result.lComp, 0.79);
});

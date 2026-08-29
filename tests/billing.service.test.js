const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateScanCharge } = require('../src/services/billing.service');

test('calculateScanCharge applies non-zero baseline even when token usage is zero', () => {
  const result = calculateScanCharge({
    promptTokens: 0,
    completionTokens: 0,
    erf: 97,
    kComp: 0.27,
    aComp: 0,
  });

  assert.equal(result.inputCostUsd, 0);
  assert.equal(result.outputCostUsd, 0);
  assert.equal(result.totalUsd, 0);
  assert.equal(result.kComp, 0.27);
  assert.equal(result.aComp, 0);
  assert.equal(result.totalScanCharge, 0.27);
});

test('calculateScanCharge computes positive charge for token usage', () => {
  const result = calculateScanCharge({
    promptTokens: 10000,
    completionTokens: 5000,
    erf: 97,
    inputTokenPricePerMillionUsd: 0.2,
    outputTokenPricePerMillionUsd: 1.2,
    kComp: 0.27,
    aComp: 0,
  });

  assert.ok(result.totalUsd > 0);
  assert.ok(result.lComp > 0);
  assert.ok(result.totalScanCharge > 0.27);
});

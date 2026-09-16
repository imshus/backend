/**
 * "DIA WT 1.56/550" is a weight and a rate on one line: 1.56 carats at 550.
 *
 * The whole pair used to reach the review card as the weight, so the weight
 * was wrong and the rate was empty — and the MRP was computed from both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../src/services/openai.service');

const { splitWeightRatePairs } = _internal;

const oneDiamond = (weight, rate = '') => ({
  structuredData: {
    diamonds: [
      {
        weight: { value: weight, confidence: 92 },
        rate: { value: rate, confidence: rate ? 90 : 0 },
      },
    ],
  },
});

test('a weight line carrying its rate is split into the two numbers', () => {
  for (const printed of ['1.56/550', '1.56|550', '1.56\\550', '1.56 / 550']) {
    const data = oneDiamond(printed);
    splitWeightRatePairs(data);
    const stone = data.structuredData.diamonds[0];
    assert.equal(stone.weight.value, '1.56', `weight from "${printed}"`);
    assert.equal(stone.rate.value, '550', `rate from "${printed}"`);
    // The same printed characters, so the rate is as certain as the weight.
    assert.equal(stone.rate.confidence, 92);
  }
});

test('the misread separators are split too, the way OCR returns them', () => {
  for (const printed of ['1.56I550', '1.56l550', '1.56L550']) {
    const data = oneDiamond(printed);
    splitWeightRatePairs(data);
    assert.equal(data.structuredData.diamonds[0].weight.value, '1.56');
    assert.equal(data.structuredData.diamonds[0].rate.value, '550');
  }
});

test('two weights are not a weight and a rate', () => {
  const data = oneDiamond('0.50/0.25');
  splitWeightRatePairs(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '0.50/0.25');
  assert.equal(data.structuredData.diamonds[0].rate.value, '');
});

test('a weight followed by a letter code is left to the separator repair', () => {
  const data = oneDiamond('0.64|PDUUU');
  splitWeightRatePairs(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '0.64|PDUUU');
});

test('a clean weight and rate are untouched', () => {
  const data = oneDiamond('2.14', '7400');
  splitWeightRatePairs(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '2.14');
  assert.equal(data.structuredData.diamonds[0].rate.value, '7400');
});

test('a rate printed in its own field is never replaced by the pair', () => {
  const data = oneDiamond('1.56/550', '9000');
  splitWeightRatePairs(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '1.56');
  assert.equal(data.structuredData.diamonds[0].rate.value, '9000');
});

test('the flat fields the review card reads are split as well', () => {
  const data = {
    structuredData: {
      diamondWeight: { value: '1.56/550', confidence: 88 },
      diamondRate: { value: '', confidence: 0 },
      coloredStoneWeight: { value: '10.82/500', confidence: 70 },
      coloredStoneRate: { value: '', confidence: 0 },
    },
  };
  splitWeightRatePairs(data);
  assert.deepEqual(data.structuredData.diamondWeight, { value: '1.56', confidence: 88 });
  assert.deepEqual(data.structuredData.diamondRate, { value: '550', confidence: 88 });
  assert.deepEqual(data.structuredData.coloredStoneWeight, { value: '10.82', confidence: 70 });
  assert.deepEqual(data.structuredData.coloredStoneRate, { value: '500', confidence: 70 });
});

test('a stone with no rate field of its own gets one', () => {
  const data = { structuredData: { diamonds: [{ weight: { value: '1.56/550', confidence: 92 } }] } };
  splitWeightRatePairs(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '1.56');
  assert.equal(data.structuredData.diamonds[0].rate.value, '550');
});

/**
 * The separator misread on the rate's side of the slash.
 *
 * When the reader keeps the weight and the rate apart but takes the "/" for
 * the rate's first digit, "1.48/550" comes back as 550 per carat printed as
 * 1550 — nearly three times the price, and plausible enough to be believed.
 * The rate is repaired against that reading's own transcript.
 */

const { correctSeparatorMisreads } = _internal;

const readWithRate = (rate, merged, weight = '1.48') => ({
  rawText: { merged },
  structuredData: {
    diamonds: [
      {
        weight: { value: weight, confidence: 90 },
        rate: { value: rate, confidence: 90 },
      },
    ],
  },
});

test('a separator taken for the rate\'s leading digit is dropped', () => {
  for (const separator of ['/', '\\', '|']) {
    const data = readWithRate('1550', `18K G.WT 10.520 DIA WT 1.48${separator}550`);
    correctSeparatorMisreads(data);
    const stone = data.structuredData.diamonds[0];
    assert.equal(stone.rate.value, '550', `rate after "${separator}"`);
    // Rewritten, so no longer certain.
    assert.equal(stone.rate.confidence, 60);
  }
});

test('a rate the tag really prints is left alone', () => {
  const data = readWithRate('1550', 'DIA WT 1.48 RATE 1550');
  correctSeparatorMisreads(data);
  assert.equal(data.structuredData.diamonds[0].rate.value, '1550');
  assert.equal(data.structuredData.diamonds[0].rate.confidence, 90);
});

test('digits that only look like the rate do not trigger the repair', () => {
  // "550" appears, but as the tail of another number, not after a separator.
  const data = readWithRate('1550', 'DIA WT 1.48 SR NO 26550');
  correctSeparatorMisreads(data);
  assert.equal(data.structuredData.diamonds[0].rate.value, '1550');
});

test('rates without the misread digit are untouched', () => {
  for (const rate of ['550', '9000', '2550']) {
    const data = readWithRate(rate, `DIA WT 1.48/${rate}`);
    correctSeparatorMisreads(data);
    assert.equal(data.structuredData.diamonds[0].rate.value, rate);
  }
});

test('the flat colorstone rate is repaired the same way', () => {
  const data = {
    rawText: { merged: 'CS WT 10.82|500' },
    structuredData: {
      coloredStoneWeight: { value: '10.82', confidence: 70 },
      coloredStoneRate: { value: '1500', confidence: 70 },
    },
  };
  correctSeparatorMisreads(data);
  assert.equal(data.structuredData.coloredStoneRate.value, '500');
});

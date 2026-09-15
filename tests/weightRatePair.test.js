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

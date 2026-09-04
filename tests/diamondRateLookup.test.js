const test = require('node:test');
const assert = require('node:assert/strict');

const { findDiamondRateMatch } = require('../src/services/diamondRateLookup.service');

const rows = [
  { rate: 100, packetCode: 'PK-10', color: 'D', clarity: 'IF', shape: 'RD' },
  { rate: 200, packetCode: '', color: 'IJ', clarity: 'VS-SI', shape: '' },
  { rate: 300, packetCode: '', color: 'IJ', clarity: 'VS-SI', shape: 'RD' },
  { rate: 400, packetCode: '', color: '', clarity: '', shape: 'EM' },
  { rate: 500, packetCode: '', color: 'GH', clarity: '', shape: '' },
];

test('diamond lookup matches packet codes regardless of punctuation and case', () => {
  const match = findDiamondRateMatch(rows, { packetCode: 'pk10' });
  assert.equal(match?.rate, 100);
});

test('diamond lookup prefers the most specific grade and shape row', () => {
  const match = findDiamondRateMatch(rows, {
    color: 'ij',
    clarity: 'vssi',
    shape: 'rd',
  });
  assert.equal(match?.rate, 300);
});

test('diamond lookup falls back to a shape-agnostic color and clarity row', () => {
  const match = findDiamondRateMatch(rows, {
    color: 'IJ',
    clarity: 'VS SI',
    shape: 'PC',
  });
  assert.equal(match?.rate, 200);
});

test('diamond lookup detects rates configured with shape only', () => {
  const match = findDiamondRateMatch(rows, { shape: 'em' });
  assert.equal(match?.rate, 400);
});

test('diamond lookup detects rates configured with color only', () => {
  const match = findDiamondRateMatch(rows, { color: 'g-h' });
  assert.equal(match?.rate, 500);
});

test('diamond lookup does not use a packet-specific row as a grade fallback', () => {
  const match = findDiamondRateMatch(rows, {
    packetCode: 'UNKNOWN',
    color: 'D',
    clarity: 'IF',
    shape: 'RD',
  });
  assert.equal(match, null);
});

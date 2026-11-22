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

// ── "Dia.1.48\550": the number after the weight is a packet code ─────────────

const { promotePacketCodesFromRate } = require('../src/services/diamondRateLookup.service');

const reading = (rate, packetCode = '') => ({
  weight: { value: '1.48', confidence: 0.95 },
  rate: { value: rate, confidence: 0.9 },
  packetCode: { value: packetCode, confidence: packetCode ? 0.9 : 0 },
});

test('a number the master has as a packet code becomes the packet code; the misread rate goes', () => {
  const [diamond] = promotePacketCodesFromRate([reading('550')], ['550', 'PK-10']);
  assert.equal(diamond.packetCode.value, '550');
  assert.equal(diamond.rate.value, '', 'the rate is then the packet row\'s, from the master');
  assert.equal(diamond.weight.value, '1.48');
  // And pricing takes that packet's rate.
  const match = findDiamondRateMatch([{ rate: 41000, packetCode: '550' }, ...rows], {
    packetCode: diamond.packetCode.value,
  });
  assert.equal(match.rate, 41000);
});

test('a number no packet code matches stays the rate', () => {
  const [diamond] = promotePacketCodesFromRate([reading('550')], ['PK-10']);
  assert.equal(diamond.rate.value, '550');
  assert.equal(diamond.packetCode.value, '');
});

test('a diamond that already has a packet code is left alone', () => {
  const original = reading('550', 'PK-10');
  const [diamond] = promotePacketCodesFromRate([original], ['550', 'PK-10']);
  assert.equal(diamond, original);
});

test('no packet codes in the master: nothing changes', () => {
  const list = [reading('550')];
  assert.equal(promotePacketCodesFromRate(list, []), list);
});

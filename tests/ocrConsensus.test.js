const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareReads,
  applyAdjudication,
  canonical,
  CONTESTED_CONFIDENCE,
  SINGLE_SOURCE_CONFIDENCE,
  ADJUDICATED_CONFIDENCE,
} = require('../src/services/ocrConsensus');

const field = (value, confidence = 95) => ({ value, confidence });

const read = (overrides = {}) => ({
  structuredData: {
    serialNumber: field('GR10286'),
    grossWeight: field('8.208'),
    netWeight: field('8.100'),
    purity: field('18K'),
    karat: field('18K'),
    diamonds: [
      { shape: field('PC'), weight: field('0.54'), color: field('FG'), clarity: field('SI'), rate: field('8400') },
    ],
    colorstones: [],
    ...overrides,
  },
  unknownFields: [],
});

test('identical readings agree on every field and keep the higher confidence', () => {
  const a = read({ grossWeight: field('8.208', 80) });
  const b = read({ grossWeight: field('8.208', 96) });
  const { merged, disagreements, agreements } = compareReads(a, b);
  assert.equal(disagreements.length, 0);
  assert.ok(agreements >= 9);
  assert.equal(merged.structuredData.grossWeight.confidence, 96);
  assert.equal(merged.structuredData.diamonds[0].weight.value, '0.54');
});

test('numeric fields compare by value and grades compare without case or separators', () => {
  const a = read({ grossWeight: field('8.208 g'), diamonds: [{ weight: field('.54'), color: field('fg'), quality: field('FG SI') }] });
  const b = read({ grossWeight: field('8.208'), diamonds: [{ weight: field('0.540'), color: field('FG'), quality: field('FGSI') }] });
  const { disagreements } = compareReads(a, b);
  assert.deepEqual(disagreements, []);
  assert.equal(canonical('weight', '.54'), canonical('weight', '0.540'));
  assert.equal(canonical('rate', '8,400'), '8400');
});

test('a contested value stays in place at low confidence and is listed', () => {
  const a = read({ diamonds: [{ weight: field('5.54', 90) }] });
  const b = read({ diamonds: [{ weight: field('0.54', 90) }] });
  const { merged, disagreements } = compareReads(a, b);
  assert.deepEqual(disagreements, [{ path: 'diamonds[0].weight', a: '5.54', b: '0.54' }]);
  assert.equal(merged.structuredData.diamonds[0].weight.value, '5.54');
  assert.equal(merged.structuredData.diamonds[0].weight.confidence, CONTESTED_CONFIDENCE);
});

test('a value only one read found is kept but marked single-source and listed', () => {
  const a = read({ labour: field('850', 92) });
  const b = read({ labour: field('', 0) });
  const { merged, disagreements } = compareReads(a, b);
  assert.equal(merged.structuredData.labour.value, '850');
  assert.equal(merged.structuredData.labour.confidence, SINGLE_SOURCE_CONFIDENCE);
  assert.deepEqual(disagreements, [{ path: 'labour', a: '850', b: '' }]);

  const onlyB = compareReads(read({ labour: field('', 0) }), read({ labour: field('850', 92) }));
  assert.equal(onlyB.merged.structuredData.labour.value, '850');
  assert.equal(onlyB.merged.structuredData.labour.confidence, SINGLE_SOURCE_CONFIDENCE);
});

test('different stone counts become one count disagreement and doubt every stone field', () => {
  const a = read({ diamonds: [{ weight: field('0.54', 95) }, { weight: field('0.12', 95) }] });
  const b = read({ diamonds: [{ weight: field('0.66', 95) }] });
  const { merged, disagreements } = compareReads(a, b);
  assert.equal(disagreements.length, 1);
  assert.equal(disagreements[0].path, 'diamonds.count');
  assert.equal(disagreements[0].a, '2');
  assert.equal(disagreements[0].b, '1');
  assert.equal(merged.structuredData.diamonds.length, 2);
  assert.equal(merged.structuredData.diamonds[0].weight.confidence, CONTESTED_CONFIDENCE);
});

test('adjudication confirming one reading sets it at the adjudicated ceiling', () => {
  const a = read({ diamonds: [{ weight: field('5.54', 90) }] });
  const b = read({ diamonds: [{ weight: field('0.54', 90) }] });
  const { merged, disagreements } = compareReads(a, b);
  const { applied } = applyAdjudication(merged, disagreements, { 'diamonds[0].weight': ['.54', 97] });
  assert.equal(applied, 1);
  assert.equal(merged.structuredData.diamonds[0].weight.value, '.54');
  assert.equal(merged.structuredData.diamonds[0].weight.confidence, ADJUDICATED_CONFIDENCE);
});

test('adjudication with a third value keeps it below the review threshold', () => {
  const a = read({ grossWeight: field('8.208', 90) });
  const b = read({ grossWeight: field('8.203', 90) });
  const { merged, disagreements } = compareReads(a, b);
  applyAdjudication(merged, disagreements, { grossWeight: { value: '8.288', confidence: 90 } });
  assert.equal(merged.structuredData.grossWeight.value, '8.288');
  assert.ok(merged.structuredData.grossWeight.confidence < 80);
});

test('adjudication choosing the other stone count swaps in that reading of the stones', () => {
  const a = read({ diamonds: [{ weight: field('0.54', 95) }, { weight: field('0.12', 95) }] });
  const b = read({ diamonds: [{ weight: field('0.66', 95), color: field('GH', 95) }] });
  const { merged, disagreements } = compareReads(a, b);
  applyAdjudication(merged, disagreements, { 'diamonds.count': ['1', 90] });
  assert.equal(merged.structuredData.diamonds.length, 1);
  assert.equal(merged.structuredData.diamonds[0].weight.value, '0.66');
  assert.equal(merged.structuredData.diamonds[0].color.confidence, ADJUDICATED_CONFIDENCE);
});

test('missing adjudication answers leave the contested value at low confidence', () => {
  const a = read({ purity: field('750', 90) });
  const b = read({ purity: field('760', 90) });
  const { merged, disagreements } = compareReads(a, b);
  const { applied } = applyAdjudication(merged, disagreements, {});
  assert.equal(applied, 0);
  assert.equal(merged.structuredData.purity.value, '750');
  assert.equal(merged.structuredData.purity.confidence, CONTESTED_CONFIDENCE);
});

test('unknown fields from both reads are kept once', () => {
  const a = read();
  a.unknownFields = [{ abbreviation: 'SR NO', detectedValue: '261440' }];
  const b = read();
  b.unknownFields = [
    { abbreviation: 'SR NO', detectedValue: '261440' },
    { abbreviation: 'HUID', detectedValue: 'AB12CD' },
  ];
  const { merged } = compareReads(a, b);
  assert.deepEqual(
    merged.unknownFields.map((u) => u.detectedValue),
    ['261440', 'AB12CD'],
  );
});

test('the primary reading is never mutated', () => {
  const a = read({ grossWeight: field('8.208', 90) });
  const b = read({ grossWeight: field('8.203', 90) });
  compareReads(a, b);
  assert.equal(a.structuredData.grossWeight.confidence, 90);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../src/services/openai.service');

const { reconcileStoneWeightsWithGrossNet, normalizeFieldShapes, buildReadContent, syncStoneQuality } = _internal;

test('quality is rebuilt from colour and clarity after they change', () => {
  const data = {
    structuredData: {
      diamonds: [
        { color: { value: 'FG', confidence: 85 }, clarity: { value: 'SI', confidence: 92 }, quality: { value: 'EG SI', confidence: 90 } },
        { color: { value: '', confidence: 0 }, clarity: { value: 'VS1', confidence: 88 }, quality: { value: '', confidence: 0 } },
        { weight: { value: '0.10', confidence: 90 } },
      ],
      colorstones: [{ color: { value: 'Red', confidence: 80 }, clarity: { value: '', confidence: 0 } }],
    },
  };
  syncStoneQuality(data);
  assert.deepEqual(data.structuredData.diamonds[0].quality, { value: 'FG SI', confidence: 85 });
  assert.deepEqual(data.structuredData.diamonds[1].quality, { value: 'VS1', confidence: 88 });
  assert.equal(data.structuredData.diamonds[2].quality, undefined);
  assert.deepEqual(data.structuredData.colorstones[0].quality, { value: 'Red', confidence: 80 });
});

const field = (value, confidence = 95) => ({ value, confidence });

const parsed = (gross, net, diamonds = [], colorstones = []) => ({
  structuredData: {
    grossWeight: field(gross),
    netWeight: field(net),
    diamonds: diamonds.map((w) => ({ weight: field(w) })),
    colorstones: colorstones.map((w) => ({ weight: field(w) })),
  },
});

test('a single stone read with a spurious leading digit is repaired from gross minus net', () => {
  // 8.208 - 8.100 = 0.108 g = 0.54 ct; the read 5.54 cannot be.
  const data = parsed('8.208', '8.100', ['5.54']);
  reconcileStoneWeightsWithGrossNet(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '0.54');
  assert.ok(data.structuredData.diamonds[0].weight.confidence <= 75);
});

test('a reading that already fits the identity is left alone', () => {
  const data = parsed('8.208', '8.100', ['.54']);
  reconcileStoneWeightsWithGrossNet(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '.54');
  assert.equal(data.structuredData.diamonds[0].weight.confidence, 95);
});

test('with several stones, the one stone whose variant makes the total fit is repaired', () => {
  // 0.54 + 0.12 = 0.66 ct = 0.132 g; gross 8.232, net 8.100.
  const data = parsed('8.232', '8.100', ['5.54', '0.12']);
  reconcileStoneWeightsWithGrossNet(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '0.54');
  assert.equal(data.structuredData.diamonds[1].weight.value, '0.12');
  assert.equal(data.structuredData.diamonds[1].weight.confidence, 95);
});

test('two possible repairs is a guess, so nothing is changed and the weights are flagged', () => {
  // Both 1.2 -> 0.12 and 5.4 -> 0.54 style variants could fit different totals;
  // construct a case where each stone alone has a fitting variant.
  // expected = (8.300 - 8.100) / 0.2 = 1.00 ct. Stones read 5.0 and 5.0:
  // 0.5 + 5.0 no; 5.0/10 = 0.5 -> 0.5 + 5.0 = 5.5 no. Use 0.5 + 5.0 with expected 1.0:
  // stone A variant 5.0 -> 0.5 gives 0.5 + 0.5 = 1.0 fits; stone B likewise.
  const data = parsed('8.300', '8.100', ['5.0', '0.5']);
  data.structuredData.diamonds[1].weight = field('5.0');
  reconcileStoneWeightsWithGrossNet(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '5.0');
  assert.equal(data.structuredData.diamonds[1].weight.value, '5.0');
  assert.ok(data.structuredData.diamonds[0].weight.confidence <= 55);
  assert.ok(data.structuredData.diamonds[1].weight.confidence <= 55);
});

test('a tag with colour stones is not flagged when the identity does not close', () => {
  // Colour-stone weights may be in grams; no single repair explains it, so leave it.
  const data = parsed('8.900', '8.100', ['0.54'], ['2.10']);
  reconcileStoneWeightsWithGrossNet(data);
  assert.equal(data.structuredData.diamonds[0].weight.confidence, 95);
  assert.equal(data.structuredData.colorstones[0].weight.confidence, 95);
});

test('without both gross and net weights nothing happens', () => {
  const data = parsed('8.208', '', ['5.54']);
  reconcileStoneWeightsWithGrossNet(data);
  assert.equal(data.structuredData.diamonds[0].weight.value, '5.54');
});

test('array-shaped fields are restored to objects before any repair runs', () => {
  const data = normalizeFieldShapes({
    structuredData: {
      grossWeight: ['8.208', 97],
      netWeight: ['8.100', 97],
      diamonds: [{ weight: ['5.54', 88], color: ['FG', 90] }],
    },
  });
  reconcileStoneWeightsWithGrossNet(data);
  assert.deepEqual(data.structuredData.diamonds[0].weight, { value: '0.54', confidence: 75 });
  assert.deepEqual(data.structuredData.diamonds[0].color, { value: 'FG', confidence: 90 });
});

test('a read sends the whole image before its magnified parts, per side', () => {
  const views = {
    full: 'FULL',
    quarters: [
      { name: 'top-left quarter', base64: 'Q1' },
      { name: 'top-right quarter', base64: 'Q2' },
    ],
    thirds: [{ name: 'left third', base64: 'T1' }],
  };
  const content = buildReadContent('PROMPT', [{ label: 'Front', views }], 'quarters');
  const images = content.filter((c) => c.type === 'image_url').map((c) => c.image_url.url.slice(-2));
  assert.deepEqual(images, ['LL', 'Q1', 'Q2']);
  assert.ok(content.every((c) => c.type !== 'image_url' || c.image_url.detail === 'high'));
  const thirds = buildReadContent('PROMPT', [{ label: 'Front', views }], 'thirds');
  assert.equal(thirds.filter((c) => c.type === 'image_url').length, 2);
  const plain = buildReadContent('PROMPT', [{ label: 'Front', views: { full: 'FULL', quarters: [], thirds: [] } }], 'quarters');
  assert.equal(plain.filter((c) => c.type === 'image_url').length, 1);
});

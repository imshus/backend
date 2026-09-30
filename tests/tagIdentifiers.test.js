/**
 * The analyze response lists every identifier on the tag, so the app can
 * match its Item Code master against an item code the reader set aside.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { tagIdentifiersOf } = require('../src/utils/tagIdentifiers');

test('the chosen number first, then every number set aside', () => {
  const ids = tagIdentifiersOf({
    structuredData: { serialNumber: { value: '261440', confidence: 90 } },
    unknownFields: [
      { label: 'SR NO', value: 'GR10286' },
      { abbreviation: 'HUID', detectedValue: 'AB12CD' },
    ],
  });
  assert.deepEqual(ids, ['261440', 'GR10286', 'AB12CD']);
});

test('reads a [value, confidence] pair and a plain string', () => {
  assert.deepEqual(tagIdentifiersOf({ structuredData: { serialNumber: ['PSE 1086', 88] } }), ['PSE 1086']);
  assert.deepEqual(tagIdentifiersOf({ structuredData: { serialNumber: 'LR 2231' } }), ['LR 2231']);
});

test('drops blanks and repeats, ignoring case', () => {
  const ids = tagIdentifiersOf({
    structuredData: { serialNumber: { value: 'gr10286' } },
    unknownFields: [{ value: 'GR10286' }, { value: '  ' }, null, { label: 'X' }],
  });
  assert.deepEqual(ids, ['gr10286']);
});

test('nothing read gives an empty list', () => {
  assert.deepEqual(tagIdentifiersOf(undefined), []);
  assert.deepEqual(tagIdentifiersOf({}), []);
  assert.deepEqual(tagIdentifiersOf({ structuredData: { serialNumber: ['', 0] }, unknownFields: [] }), []);
});

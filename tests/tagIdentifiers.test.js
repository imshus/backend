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

test('identifiers printed with a label are taken from the transcript', () => {
  const ids = tagIdentifiersOf({
    structuredData: { serialNumber: ['GR10286', 96] },
    rawText: { merged: 'DIA WT .54\nGR. WT 8.208\nNET WT 8.100\nCS WT\nSR NO 261440\nST NO GR10286' },
  });
  assert.deepEqual(ids, ['GR10286', '261440']);
});

test('SR, CODE and S.NO forms, and an unlabelled code line, are read', () => {
  const ids = tagIdentifiersOf({
    structuredData: { serialNumber: ['', 0] },
    rawText: { merged: 'G.WT 3.388\nN.WT 3.288\nSR 838338\nCODE R8338\nS.NO: 4471\nPSE 1086' },
  });
  assert.deepEqual(ids, ['838338', 'R8338', '4471', 'PSE 1086']);
});

test('weights, labour and karat in the transcript are not identifiers', () => {
  const ids = tagIdentifiersOf({
    structuredData: { serialNumber: ['836380', 95] },
    rawText: { merged: 'GR WT 18.368\nNET WT 18.168\nDIA WT 1.00\nKT 18K\nSR NO 836380\nLBR 1338\nST WT 0.50' },
  });
  assert.deepEqual(ids, ['836380']);
});

test('a plain-string transcript and a stored unknownFields list are both read', () => {
  const ids = tagIdentifiersOf({
    structuredData: { serialNumber: 'LR 2231' },
    unknownFields: [{ abbreviation: 'HUID', detectedValue: 'AB12CD' }],
    rawText: 'TAG NO 5512',
  });
  assert.deepEqual(ids, ['LR 2231', 'AB12CD', '5512']);
});

test('nothing read gives an empty list', () => {
  assert.deepEqual(tagIdentifiersOf(undefined), []);
  assert.deepEqual(tagIdentifiersOf({}), []);
  assert.deepEqual(tagIdentifiersOf({ structuredData: { serialNumber: ['', 0] }, unknownFields: [] }), []);
});

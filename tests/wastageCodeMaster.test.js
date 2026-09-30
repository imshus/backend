/**
 * The number on a tag goes where its master says: a Masters -> Wastage code
 * is shown on Wastage and charged at its percent; an item code is shown on
 * Item Code only and is never used as a wastage code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveWastage, findWastageRow } = require('../src/services/wastageResolution.service');

test('a number in the Wastage master is the wastage code, at its percent', () => {
  const result = resolveWastage({ wastageRow: { code: 'W12', percent: 8 }, itemRow: null });
  assert.deepEqual(result, { percent: 8, code: 'W12' });
});

test('an item code is never shown as a wastage code', () => {
  // The number is a saved item code carrying its own wastage percent, and
  // not a Masters -> Wastage code: the percent still prices, no code shows.
  const result = resolveWastage({ wastageRow: null, itemRow: { code: 'RING101', wastage: 6 } });
  assert.deepEqual(result, { percent: 6, code: '' });
});

test('in both masters: the Wastage master percent is charged and its code shown', () => {
  const result = resolveWastage({
    wastageRow: { code: 'R7', percent: 9 },
    itemRow: { code: 'R7', wastage: 4 },
  });
  assert.deepEqual(result, { percent: 9, code: 'R7' });
});

test('a percent typed for this scan beats both masters', () => {
  const result = resolveWastage({
    manualPercent: '5',
    wastageRow: { code: 'W12', percent: 8 },
    itemRow: { wastage: 6 },
  });
  assert.deepEqual(result, { percent: 5, code: 'W12' });
});

test('a Wastage code without a figure falls back to the item, and in none there is no wastage', () => {
  assert.deepEqual(
    resolveWastage({ wastageRow: { code: 'W1', percent: null }, itemRow: { wastage: 3 } }),
    { percent: 3, code: 'W1' },
  );
  assert.deepEqual(resolveWastage({ wastageRow: null, itemRow: null }), { percent: 0, code: '' });
  assert.deepEqual(resolveWastage(), { percent: 0, code: '' });
});

test('a wastage code printed anywhere on the tag is found, main number first', () => {
  const rows = [{ code: 'W8', percent: 8 }, { code: 'W12', percent: 12 }];
  // The reader chose SR NO 261440 as the number; W12 was set aside.
  assert.equal(findWastageRow(rows, ['261440', 'W12'])?.code, 'W12');
  // Spacing, dashes and case do not matter.
  assert.equal(findWastageRow(rows, ['w-8'])?.code, 'W8');
  // Two codes on a tag: the one read first wins.
  assert.equal(findWastageRow(rows, ['W8', 'W12'])?.code, 'W8');
  assert.equal(findWastageRow(rows, ['261440']), null);
  assert.equal(findWastageRow([], ['W8']), null);
  assert.equal(findWastageRow(rows, []), null);
});

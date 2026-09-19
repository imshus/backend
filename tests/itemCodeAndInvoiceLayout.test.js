/**
 * Two additions from the design: item codes carry the wastage and labour that
 * kind of item usually attracts, and a shop chooses how its sales invoice
 * groups what was scanned.
 *
 * The figures are deliberately nullable. Zero wastage and "the shop has not
 * said" price differently, so a blank field must not arrive as a nought.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ItemCode = require('../src/models/itemCode.model');
const FormulaConfig = require('../src/models/formulaConfig.model');

test('an item code can carry wastage and labour, and neither is required', () => {
  const wastage = ItemCode.schema.path('wastage');
  const labour = ItemCode.schema.path('labour');

  assert.equal(String(wastage.instance), 'Number');
  assert.equal(String(labour.instance), 'Number');
  // Blank stays blank: null, not 0.
  assert.equal(wastage.options.default, null);
  assert.equal(labour.options.default, null);
  // Wastage is a percentage; labour cannot be negative.
  assert.equal(wastage.options.min, 0);
  assert.equal(wastage.options.max, 100);
  assert.equal(labour.options.min, 0);
});

test('an item code with neither figure still validates', async () => {
  const item = new ItemCode({
    businessId: '6a9044b72d0877016c0c2f6a',
    code: 'GR',
    description: 'Gold Ring',
  });
  await item.validate();
  assert.equal(item.wastage, null);
  assert.equal(item.labour, null);
});

test('wastage over a hundred per cent is refused', async () => {
  const item = new ItemCode({
    businessId: '6a9044b72d0877016c0c2f6a',
    code: 'GR',
    wastage: 120,
  });
  await assert.rejects(() => item.validate(), /wastage/i);
});

test('the sales invoice groups one of three ways, separate lines by default', () => {
  const path = FormulaConfig.schema.path('salesInvoiceLayout');
  assert.equal(path.options.default, 'SEPARATE');
  assert.deepEqual(path.options.enum, ['SEPARATE', 'GOLD_WITH_LABOUR', 'GOLD_WITH_WASTAGE']);
});

test('an invoice layout the app does not offer is refused', async () => {
  const config = new FormulaConfig({
    businessId: '6a9044b72d0877016c0c2f6a',
    salesInvoiceLayout: 'GOLD_WITH_EVERYTHING',
  });
  await assert.rejects(() => config.validate(), /salesInvoiceLayout/i);
});

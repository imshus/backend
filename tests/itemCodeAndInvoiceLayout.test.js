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

// ── The unit an item's labour is saved in (follow-up finding 11) ─────────

test('an item\'s labour carries its unit: per gram by default, per 10 g or a percent of the gold value', async () => {
  const unit = ItemCode.schema.path('labourUnit');
  assert.deepEqual(unit.options.enum, ['Per Gram', 'Per 10 Gram', 'Percent']);
  assert.equal(unit.options.default, 'Per Gram');
  const item = new ItemCode({ businessId: '6a9044b72d0877016c0c2f6a', code: 'GR', labour: 12, labourUnit: 'Percent' });
  await item.validate();
  await assert.rejects(
    () => new ItemCode({ businessId: '6a9044b72d0877016c0c2f6a', code: 'GR', labourUnit: 'Per Piece' }).validate(),
    /labourUnit/,
  );
});

test('Masters saves the labour unit sent, keeps the saved one when a build sends none, and refuses a percent over 100', async () => {
  const controller = require('../src/controllers/itemCode.controller');
  const OWNER = { businessId: '6a9044b72d0877016c0c2f6a', userId: '6a9044b72d0877016c0c2f6b', role: 'OWNER' };
  const original = { create: ItemCode.create, findOne: ItemCode.findOne };
  const created = [];
  const existing = new ItemCode({ businessId: OWNER.businessId, code: 'GR', labour: 7000, labourUnit: 'Per 10 Gram' });
  existing.save = async function save() { return this; };
  ItemCode.create = async (doc) => { created.push(doc); return doc; };
  ItemCode.findOne = async () => existing;
  const save = async (body) => {
    const res = {
      statusCode: null, body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await controller.saveItemCode({ user: OWNER, body }, res);
    return res;
  };
  try {
    let res = await save({ code: 'gr', labour: '12', labourUnit: 'Percent' });
    assert.equal(res.statusCode, 200);
    assert.equal(created[0].labourUnit, 'Percent');

    res = await save({ code: 'br', labour: '700' });
    assert.equal(res.statusCode, 200);
    assert.equal(created[1].labourUnit, undefined, 'a new row takes the per-gram default');

    // An edit from a build that sends no unit leaves Per 10 Gram as saved.
    res = await save({ id: String(existing._id), code: 'GR', labour: '6500' });
    assert.equal(res.statusCode, 200);
    assert.equal(existing.labour, 6500);
    assert.equal(existing.labourUnit, 'Per 10 Gram');

    res = await save({ code: 'NK', labour: '120', labourUnit: 'Percent' });
    assert.equal(res.statusCode, 400);
    res = await save({ code: 'NK', labour: '120', labourUnit: 'Per Piece' });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Labour unit/);
  } finally {
    ItemCode.create = original.create;
    ItemCode.findOne = original.findOne;
  }
});

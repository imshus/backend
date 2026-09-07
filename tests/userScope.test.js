const test = require('node:test');
const assert = require('node:assert/strict');

const {
  settingsScope,
  ownWorkFilter,
  findScopedSetting,
  upsertScopedSetting,
  isOwnerRole,
} = require('../src/services/userScope.service');
const { InvoiceCounter, generateInvoiceNumber, peekNextInvoiceNumber } = require('../src/models/invoiceCounter.model');

const owner = { businessId: 'biz-1', userId: 'owner-1', role: 'OWNER' };
const employee = { businessId: 'biz-1', userId: 'emp-7', role: 'EMP' };

test('the owner is the business; an employee is themselves', () => {
  assert.ok(isOwnerRole('OWNER'));
  assert.ok(isOwnerRole('super'));
  assert.ok(!isOwnerRole('EMP'));
  assert.deepEqual(settingsScope(owner), { businessId: 'biz-1', owner: true, userId: null });
  assert.deepEqual(settingsScope(employee), { businessId: 'biz-1', owner: false, userId: 'emp-7' });
  assert.deepEqual(ownWorkFilter(owner), {});
  assert.deepEqual(ownWorkFilter(employee), { userId: 'emp-7' });
});

test("an employee reads their own setting when it exists, else the shop's", async () => {
  const calls = [];
  const Model = {
    findOne: async (filter) => {
      calls.push(filter);
      if (filter.userId === 'emp-7') return null;
      return { mcxChange: 'shop' };
    },
  };
  const found = await findScopedSetting(Model, settingsScope(employee));
  assert.deepEqual(found, { mcxChange: 'shop' });
  assert.deepEqual(calls, [
    { businessId: 'biz-1', userId: 'emp-7' },
    { businessId: 'biz-1', userId: null },
  ]);

  const own = { findOne: async (filter) => (filter.userId === 'emp-7' ? { mcxChange: 'mine' } : null) };
  assert.deepEqual(await findScopedSetting(own, settingsScope(employee)), { mcxChange: 'mine' });
});

test("the owner reads the shop's record without looking for a personal one", async () => {
  const calls = [];
  const Model = { findOne: async (filter) => { calls.push(filter); return { v: 1 }; } };
  await findScopedSetting(Model, settingsScope(owner));
  assert.deepEqual(calls, [{ businessId: 'biz-1', userId: null }]);
});

test("the owner writes the shop's record; an employee writes their own", async () => {
  const writes = [];
  const Model = {
    findOneAndUpdate: async (filter, update, options) => {
      writes.push({ filter, update, options });
      return { ok: true };
    },
  };
  await upsertScopedSetting(Model, settingsScope(owner), { activeFormula: 'F2' });
  await upsertScopedSetting(Model, settingsScope(employee), { activeFormula: 'F1' });
  assert.deepEqual(writes[0].filter, { businessId: 'biz-1', userId: null });
  assert.deepEqual(writes[0].update, { $set: { activeFormula: 'F2' } });
  assert.equal(writes[0].options.upsert, true);
  assert.deepEqual(writes[1].filter, { businessId: 'biz-1', userId: 'emp-7' });
});

test('invoice numbers count per business per day, and a business is required', async () => {
  const originalUpdate = InvoiceCounter.findOneAndUpdate;
  const originalFind = InvoiceCounter.findOne;
  const seen = [];
  const counters = new Map();
  InvoiceCounter.findOneAndUpdate = async (filter) => {
    seen.push(filter);
    const key = `${filter.businessId}|${filter.dateKey}`;
    counters.set(key, (counters.get(key) || 0) + 1);
    return { seq: counters.get(key) };
  };
  InvoiceCounter.findOne = async (filter) => {
    const key = `${filter.businessId}|${filter.dateKey}`;
    return counters.has(key) ? { seq: counters.get(key) } : null;
  };
  try {
    const a1 = await generateInvoiceNumber('shop-a');
    const a2 = await generateInvoiceNumber('shop-a');
    const b1 = await generateInvoiceNumber('shop-b');
    assert.match(a1, /^INV-\d{4}-\d{4}-00001$/);
    assert.match(a2, /-00002$/);
    // The other shop starts its own count; the numbers may coincide.
    assert.match(b1, /-00001$/);
    assert.ok(seen.every((f) => f.businessId && f.dateKey));
    assert.match(await peekNextInvoiceNumber('shop-a'), /-00003$/);
    assert.match(await peekNextInvoiceNumber('shop-c'), /-00001$/);
    await assert.rejects(() => generateInvoiceNumber(undefined), /belongs to a business/);
  } finally {
    InvoiceCounter.findOneAndUpdate = originalUpdate;
    InvoiceCounter.findOne = originalFind;
  }
});

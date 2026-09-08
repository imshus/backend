const test = require('node:test');
const assert = require('node:assert/strict');

const {
  settingsScope,
  findScopedRows,
  materializeOwnRows,
  resolveScopedRowById,
} = require('../src/services/userScope.service');

const owner = settingsScope({ businessId: 'biz-1', userId: 'owner-1', role: 'OWNER' });
const employee = settingsScope({ businessId: 'biz-1', userId: 'emp-7', role: 'EMP' });

/** An in-memory stand-in for a rate collection. */
function fakeTable(rows) {
  const table = { rows: rows.map((row, i) => ({ _id: row._id || `r${i}`, userId: null, ...row })) };
  const matches = (row, filter) =>
    Object.entries(filter).every(([key, value]) => {
      const actual = row[key] ?? null;
      return String(actual ?? '') === String(value ?? '');
    });
  // find() must behave like a mongoose Query: awaitable, with .lean().
  const asQuery = (result) => {
    const promise = Promise.resolve(result);
    promise.lean = () => Promise.resolve(result);
    return promise;
  };
  table.find = (filter) => asQuery(table.rows.filter((row) => matches(row, filter)));
  table.findOne = async (filter) => table.rows.find((row) => matches(row, filter)) || null;
  table.countDocuments = async (filter) => (await table.find(filter)).length;
  table.insertMany = async (docs) => {
    for (const doc of docs) table.rows.push({ _id: `n${table.rows.length}`, ...doc });
  };
  return table;
}

test('an employee reads the shop rows until they have their own set', async () => {
  const Model = fakeTable([
    { _id: 'g1', businessId: 'biz-1', carat: '22Kt', rate: 100 },
    { _id: 'g2', businessId: 'biz-1', carat: '18Kt', rate: 80 },
  ]);
  const inherited = await findScopedRows(Model, employee);
  assert.deepEqual(inherited.map((r) => r._id), ['g1', 'g2']);

  Model.rows.push({ _id: 'mine', businessId: 'biz-1', userId: 'emp-7', carat: '22Kt', rate: 111 });
  const own = await findScopedRows(Model, employee);
  assert.deepEqual(own.map((r) => r._id), ['mine']);

  const shop = await findScopedRows(Model, owner);
  assert.deepEqual(shop.map((r) => r._id), ['g1', 'g2']);
});

test("materialize copies the shop's table once, and never for the owner", async () => {
  const Model = fakeTable([
    { _id: 'g1', businessId: 'biz-1', carat: '22Kt', rate: 100 },
    { _id: 'g2', businessId: 'biz-1', carat: '18Kt', rate: 80 },
  ]);
  assert.equal(await materializeOwnRows(Model, owner), false);

  assert.equal(await materializeOwnRows(Model, employee), true);
  const own = await Model.find({ businessId: 'biz-1', userId: 'emp-7' });
  assert.deepEqual(own.map((r) => [r.carat, r.rate]), [['22Kt', 100], ['18Kt', 80]]);

  // A second write must not duplicate the copy.
  assert.equal(await materializeOwnRows(Model, employee), false);
  assert.equal(await Model.countDocuments({ businessId: 'biz-1', userId: 'emp-7' }), 2);
});

test('a shop-row id resolves to the matching row of the writer\'s own copy', async () => {
  const Model = fakeTable([
    { _id: 'shop-22', businessId: 'biz-1', carat: '22Kt', rate: 100 },
  ]);
  await materializeOwnRows(Model, employee);

  // The client still shows the shop row's id from before the copy existed.
  const resolved = await resolveScopedRowById(Model, employee, 'shop-22', ['carat']);
  assert.ok(resolved);
  assert.equal(resolved.userId, 'emp-7');
  assert.equal(resolved.carat, '22Kt');

  // The owner resolving their own row gets it straight back.
  const shopRow = await resolveScopedRowById(Model, owner, 'shop-22', ['carat']);
  assert.equal(shopRow._id, 'shop-22');

  // An id from another business resolves to nothing.
  assert.equal(await resolveScopedRowById(Model, settingsScope({ businessId: 'biz-2', userId: 'x', role: 'EMP' }), 'shop-22', ['carat']), null);
});

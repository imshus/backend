/**
 * The old Tax-box default of 3 comes off the records that carry it, once:
 * a shop that types 3 afterwards keeps it, one that typed another number is
 * never touched, and a failed run is retried on the next start.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resetOldRtgsTaxDefault, MARKER_ID } = require('../src/services/rtgsTaxDefaultReset.service');

function fakeStore(records) {
  const rows = records.map((record) => ({ ...record }));
  const Model = {
    find: (filter) => ({
      lean: async () => rows.filter((row) => row.rtgsTaxPercent === filter.rtgsTaxPercent),
    }),
    updateMany: async (filter, update) => {
      let modifiedCount = 0;
      for (const row of rows) {
        if (row.rtgsTaxPercent === filter.rtgsTaxPercent) {
          Object.assign(row, update.$set);
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    },
  };
  return { rows, Model };
}

function fakeMarkers() {
  const docs = new Map();
  return {
    docs,
    insertOne: async (doc) => {
      if (docs.has(doc._id)) {
        const error = new Error('E11000 duplicate key');
        error.code = 11000;
        throw error;
      }
      docs.set(doc._id, { ...doc });
    },
    updateOne: async (filter, update) => {
      docs.set(filter._id, { ...docs.get(filter._id), ...update.$set });
    },
    deleteOne: async (filter) => {
      docs.delete(filter._id);
    },
  };
}

const quiet = { info: () => {}, warn: () => {} };

test('every record at the old 3 becomes 0; other numbers are left as chosen', async () => {
  const { rows, Model } = fakeStore([
    { businessId: 'a', rtgsTaxPercent: 3 },
    { businessId: 'a', userId: 'emp', rtgsTaxPercent: 3 },
    { businessId: 'b', rtgsTaxPercent: 2 },
    { businessId: 'c', rtgsTaxPercent: 0 },
    { businessId: 'd', rtgsTaxPercent: 5 },
  ]);
  const markers = fakeMarkers();
  const invalidated = [];

  const result = await resetOldRtgsTaxDefault({
    Model, markers, invalidate: async (id) => { invalidated.push(id); }, log: quiet,
  });

  assert.deepEqual(result, { ran: true, changed: 2 });
  assert.deepEqual(rows.map((row) => row.rtgsTaxPercent), [0, 0, 2, 0, 5]);
  assert.deepEqual(invalidated, ['a'], 'the changed shop\'s cached rates are dropped, once');
  assert.equal(markers.docs.get(MARKER_ID).changed, 2);
});

test('it runs once: a shop that types 3 after the reset keeps its 3', async () => {
  const { rows, Model } = fakeStore([{ businessId: 'a', rtgsTaxPercent: 3 }]);
  const markers = fakeMarkers();
  await resetOldRtgsTaxDefault({ Model, markers, invalidate: async () => {}, log: quiet });
  assert.equal(rows[0].rtgsTaxPercent, 0);

  rows[0].rtgsTaxPercent = 3; // typed by the shop afterwards
  const again = await resetOldRtgsTaxDefault({ Model, markers, invalidate: async () => {}, log: quiet });
  assert.deepEqual(again, { ran: false, changed: 0 });
  assert.equal(rows[0].rtgsTaxPercent, 3);
});

test('a run that fails releases its claim, so the next start tries again', async () => {
  const { rows, Model } = fakeStore([{ businessId: 'a', rtgsTaxPercent: 3 }]);
  const markers = fakeMarkers();
  const broken = { ...Model, updateMany: async () => { throw new Error('db down'); } };

  await assert.rejects(
    resetOldRtgsTaxDefault({ Model: broken, markers, invalidate: async () => {}, log: quiet }),
    /db down/,
  );
  assert.equal(markers.docs.has(MARKER_ID), false);

  const retried = await resetOldRtgsTaxDefault({ Model, markers, invalidate: async () => {}, log: quiet });
  assert.deepEqual(retried, { ran: true, changed: 1 });
  assert.equal(rows[0].rtgsTaxPercent, 0);
});

test('a cache that cannot be cleared does not stop the reset', async () => {
  const { rows, Model } = fakeStore([{ businessId: 'a', rtgsTaxPercent: 3 }]);
  const result = await resetOldRtgsTaxDefault({
    Model, markers: fakeMarkers(), invalidate: async () => { throw new Error('redis down'); }, log: quiet,
  });
  assert.deepEqual(result, { ran: true, changed: 1 });
  assert.equal(rows[0].rtgsTaxPercent, 0);
});

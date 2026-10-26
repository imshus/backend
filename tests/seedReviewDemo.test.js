/**
 * scripts/seed_review_demo.js: the App Store review shop gets the sample
 * labour, wastage and item codes it is missing — only on --apply, never
 * touching codes the shop already has, and never for a number with no owner.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const BusinessUser = require('../src/models/businessUser.model');
const WastageCode = require('../src/models/wastageCode.model');
const LabourCode = require('../src/models/labourCode.model');
const ItemCode = require('../src/models/itemCode.model');
const { seedReviewDemo, SAMPLE_WASTAGE, SAMPLE_LABOUR, SAMPLE_ITEMS } = require('../scripts/seed_review_demo');

let mongoServer;
const businessId = new mongoose.Types.ObjectId();
const PHONE = '9876500001';

test.before(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongoServer.getUri());
  await BusinessUser.collection.insertOne({ businessId, phone: PHONE, role: 'OWNER', createdAt: new Date() });
  // The shop already has its own WS-08 at 9%: it must stay as it is.
  await WastageCode.create({ businessId, userId: null, code: 'WS-08', percent: 9 });
});

test.after(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const silently = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

test('a dry run lists what is missing and writes nothing', async () => {
  const result = await silently(() => seedReviewDemo({ phone: PHONE }));
  assert.equal(result.applied, false);
  assert.deepEqual(result.added.wastageCodes, ['WS-05', 'WS-10', 'WS-12']);
  assert.equal(result.added.labourCodes.length, SAMPLE_LABOUR.length);
  assert.equal(await LabourCode.countDocuments({ businessId }), 0);
  assert.equal(await WastageCode.countDocuments({ businessId }), 1);
});

test('--apply adds the missing codes and keeps the shop\'s own', async () => {
  await silently(() => seedReviewDemo({ phone: `+91 ${PHONE}`, apply: true }));
  assert.equal(await WastageCode.countDocuments({ businessId }), SAMPLE_WASTAGE.length);
  assert.equal((await WastageCode.findOne({ businessId, code: 'WS-08' }).lean()).percent, 9);
  assert.equal(await LabourCode.countDocuments({ businessId }), SAMPLE_LABOUR.length);
  assert.equal((await LabourCode.findOne({ businessId, code: 'LB-03' }).lean()).rate, 415);
  assert.equal(await ItemCode.countDocuments({ businessId }), SAMPLE_ITEMS.length);
  // Again: nothing more to add.
  const again = await silently(() => seedReviewDemo({ phone: PHONE, apply: true }));
  assert.deepEqual(again.added, { wastageCodes: [], labourCodes: [], itemCodes: [] });
});

test('a number with no owner account, or not ten digits, is refused', async () => {
  await assert.rejects(() => silently(() => seedReviewDemo({ phone: '9000000000' })), /sign up in the app with it first/);
  await assert.rejects(() => silently(() => seedReviewDemo({ phone: '12345' })), /10-digit/);
});

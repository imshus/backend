/**
 * The email popup before a licence or credit payment: the address rides on
 * the order request, is kept on the shop, and a typed value that is not an
 * address stops the payment before any order exists. An app from before the
 * popup sends none and pays as before.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const CONTROLLER = path.join(__dirname, '..', 'src', 'controllers', 'payment.controller.js');
const CONTROLLER_DIR = path.dirname(CONTROLLER);

const state = { updates: [], orders: [] };

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: CONTROLLER,
    filename: CONTROLLER,
    paths: Module._nodeModulePaths(CONTROLLER_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('../models/business.model', {
  updateOne: async (filter, update) => { state.updates.push({ filter, update }); },
});
stub('../services/payment.service', {
  createOrderForApplicationPurchase: async (args) => {
    state.orders.push({ kind: 'application', ...args });
    return { orderId: 'order_1', amountInPaise: 1416000, baseAmount: 12000 };
  },
  createOrderForCreditRecharge: async (args) => {
    state.orders.push({ kind: 'credits', ...args });
    return { orderId: 'order_2', amountInPaise: 50000 };
  },
});
stub('../utils/apiResponse', {
  sendSuccess: (res, data) => { res.data = data; },
});

const { createApplicationOrder, createCreditOrder } = require(CONTROLLER);

const call = async (handler, body) => {
  state.updates = [];
  state.orders = [];
  const res = { data: null };
  let error = null;
  await handler(
    { user: { businessId: 'biz-1', userId: 'owner-1' }, body, app: { locals: {} } },
    res,
    (err) => { error = err; },
  );
  return { res, error };
};

test('the typed email is kept on the shop before the order is made', async () => {
  const { res, error } = await call(createApplicationOrder, { email: '  owner@shop.in ' });
  assert.equal(error, null);
  assert.deepEqual(state.updates, [{ filter: { _id: 'biz-1' }, update: { $set: { billingEmail: 'owner@shop.in' } } }]);
  assert.equal(state.orders.length, 1);
  assert.equal(res.data.orderId, 'order_1');
});

test('credits take the email the same way', async () => {
  await call(createCreditOrder, { amount: 500, email: 'owner@shop.in' });
  assert.equal(state.updates[0].update.$set.billingEmail, 'owner@shop.in');
  assert.equal(state.orders[0].requestedAmount, 500);
});

test('an app without the popup sends no email and pays as before', async () => {
  const { error } = await call(createApplicationOrder, {});
  assert.equal(error, null);
  assert.equal(state.updates.length, 0);
  assert.equal(state.orders.length, 1);
});

test('a value that is not an email stops the payment before any order', async () => {
  for (const email of ['owner', 'owner@shop', 'a b@shop.in', 'x@y.com\r\nBcc: z@q.com']) {
    const { error } = await call(createCreditOrder, { amount: 500, email });
    assert.equal(error?.message, 'BILLING_EMAIL_INVALID', email);
    assert.equal(state.updates.length, 0);
    assert.equal(state.orders.length, 0);
  }
});

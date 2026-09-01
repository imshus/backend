/**
 * Register page availability check: a User ID is matched against stored
 * User IDs only, never against phone numbers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const CONTROLLER = path.join(__dirname, '..', 'src', 'controllers', 'auth.controller.js');
const CONTROLLER_DIR = path.dirname(CONTROLLER);

const state = { users: [], queries: [] };

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: CONTROLLER, filename: CONTROLLER, paths: Module._nodeModulePaths(CONTROLLER_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

/** Matches only on the exact keys asked for, so a wrong query cannot pass. */
const matches = (query, user) =>
  Object.entries(query).every(([key, value]) => user[key] === value);

stub('../models/businessUser.model', {
  findOne: async (query) => {
    state.queries.push(query);
    return state.users.find((u) => matches(query, u)) || null;
  },
});
stub('../services/registration.service', {});
stub('../services/gst.service', {});
stub('../services/otp.service', {});
stub('../services/auth.service', {});
stub('../utils/apiResponse', {
  sendSuccess: (res, data) => res.finish(data),
  sendError: (res, message) => res.finish({ message }),
});

const { checkAvailability } = require(CONTROLLER);

const call = async (body) => {
  let payload;
  await checkAvailability({ body }, { finish: (p) => { payload = p; } }, (e) => { throw e; });
  return payload;
};

const reset = (users) => { state.users = users; state.queries = []; };

test('a User ID already registered is reported taken', async () => {
  reset([{ userId: 'garg.jewellers', phone: '9876543210' }]);
  const result = await call({ mobile: '', userId: 'garg.jewellers' });
  assert.equal(result.userIdTaken, true);
});

test('an unused User ID is free', async () => {
  reset([{ userId: 'garg.jewellers', phone: '9876543210' }]);
  const result = await call({ mobile: '', userId: 'new.shop' });
  assert.equal(result.userIdTaken, false);
});

test("a User ID matching someone's phone number is still free", async () => {
  // The number belongs to another account, but nobody uses it as a User ID.
  reset([{ userId: 'garg.jewellers', phone: '9876543210' }]);
  const result = await call({ mobile: '', userId: '9876543210' });
  assert.equal(result.userIdTaken, false, 'phone numbers must not reserve User IDs');
});

test('the User ID lookup queries userId only', async () => {
  reset([]);
  await call({ mobile: '', userId: '9876543210' });
  const userIdQueries = state.queries.filter((q) => 'userId' in q || '$or' in q);
  assert.equal(userIdQueries.length, 1);
  assert.deepEqual(userIdQueries[0], { userId: '9876543210' });
  assert.ok(!('$or' in userIdQueries[0]), 'must not fall back to a phone match');
});

test('a phone already registered is still reported taken', async () => {
  reset([{ userId: 'garg.jewellers', phone: '9876543210' }]);
  const result = await call({ mobile: '+91 98765 43210', userId: '' });
  assert.equal(result.phoneTaken, true);
});

test('a free phone is reported available', async () => {
  reset([{ userId: 'garg.jewellers', phone: '9876543210' }]);
  const result = await call({ mobile: '9000000000', userId: '' });
  assert.equal(result.phoneTaken, false);
});

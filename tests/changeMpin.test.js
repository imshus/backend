/**
 * Settings -> MPIN Manager: POST /auth/change-mpin.
 *
 * The signed-in account changes its own MPIN — the current one, then the new
 * one twice. An owner's token changes the owner's record; an employee's token
 * (keyed on their Employee document) changes the EMP sign-in record linked to
 * it. The new MPIN is what signs in afterwards, the old one no longer does,
 * and Forgot MPIN (the sealed copy) shows the new one. Wrong current MPINs
 * are capped at five per fifteen minutes per account.
 *
 * Runs against a real (in-memory) MongoDB and the real routes. No OTP is
 * texted: the OTP check is stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Independent of the developer's .env (dotenv never overrides these).
process.env.NODE_ENV = 'test';
process.env.USE_MEMORY_STORE = 'true';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.MSG91_AUTH_KEY = 'test';
process.env.MSG91_TEMPLATE_ID = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.SANDBOX_API_KEY = 'test';
process.env.SANDBOX_API_SECRET = 'test';
process.env.MPIN_VAULT_KEY = 'test-vault-key';

const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Business = require('../src/models/business.model');
const BusinessUser = require('../src/models/businessUser.model');
const Employee = require('../src/models/employee.model');
const authService = require('../src/services/auth.service');
const otpService = require('../src/services/otp.service');
const employeeAccounts = require('../src/services/employeeAccount.service');
const profileEditService = require('../src/services/profileEdit.service');
const redisClient = require('../src/redis/redisClient');
const { openMpin } = require('../src/utils/mpinVault');
const errorHandler = require('../src/middleware/errorHandler');

// Nothing here may text anyone.
otpService.sendMobileOtp = async () => ({ sent: true });
otpService.verifyOtpByMobile = async () => ({ verified: true });

let mongoServer;
let server;
let baseUrl;

const shop = { id: new mongoose.Types.ObjectId() };
const accounts = {};

async function api(method, path, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json };
}

const ownerToken = (owner) =>
  authService.generateTokens(String(shop.id), String(owner._id), 'OWNER').accessToken;
const employeeToken = (employee) =>
  authService.generateTokens(String(shop.id), String(employee._id), 'EMP', { permissions: {} }).accessToken;

const changeMpin = (token, currentMpin, newMpin, confirmMpin = newMpin) =>
  api('POST', '/auth/change-mpin', { token, body: { currentMpin, newMpin, confirmMpin } });
const login = (mobile, mpin) => api('POST', '/auth/login', { body: { mobile, mpin } });

/** An owner record the way registration writes an MPIN-only account. */
async function createOwner(phone, mpin, extra = {}) {
  const hash = await bcrypt.hash(mpin, 10);
  return BusinessUser.create({
    businessId: shop.id,
    phone,
    fullName: `Owner ${phone}`,
    mpinHash: hash,
    passwordHash: hash,
    role: 'OWNER',
    ...extra,
  });
}

const sealedMpinOf = async (id) => openMpin((await BusinessUser.findById(id).select('+mpinVault').lean()).mpinVault);

/**
 * Holds the next bcrypt comparison of `mpin` until let go: the moment a
 * sign-in has loaded its record and is checking the MPIN on it. Every other
 * comparison runs as usual.
 */
function holdNextCompare(mpin) {
  const original = bcrypt.compare;
  let reached;
  const atCompare = new Promise((resolve) => { reached = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let held = false;
  bcrypt.compare = async (plain, hash) => {
    if (!held && String(plain) === mpin) {
      held = true;
      bcrypt.compare = original;
      reached();
      await released;
    }
    return original(plain, hash);
  };
  return {
    atCompare,
    release,
    restore: () => {
      bcrypt.compare = original;
      release();
    },
  };
}

test.before(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([BusinessUser.init(), Employee.init()]);

  await Business.create({
    _id: shop.id,
    gstNumber: '27AAAAA0000A1Z5',
    legalName: 'SHREE JEWELLERS PVT LTD',
    tradeName: 'Shree Jewellers',
    businessType: 'Retailer',
    gstStatus: 'Active',
    address: '12 Zaveri Bazaar, Mumbai 400002',
    isRegistered: true,
  });
  // No sealed copy yet: an MPIN from before the vault existed.
  accounts.owner = await createOwner('9000000001', '1111');
  // Each test that counts wrong attempts has an account of its own.
  accounts.lockout = await createOwner('9000000002', '2222');
  accounts.recovering = await createOwner('9000000003', '3333');
  // From a build that signed in with a User ID and a password of its own.
  accounts.withPassword = await createOwner('9000000004', '4444', {
    userId: 'oldshop',
    passwordHash: await bcrypt.hash('secret123', 10),
  });

  accounts.employee = await Employee.create({ businessId: shop.id, name: 'Ravi Kumar', phone: '9811100001' });
  await employeeAccounts.createAccountFor(accounts.employee, { mpin: '0451' });
  // An employee still on the old phone + password login: no MPIN anywhere.
  accounts.passwordEmployee = await Employee.create({
    businessId: shop.id,
    name: 'Old Karigar',
    phone: '9811100002',
    passwordHash: await bcrypt.hash('oldpass', 10),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', require('../src/routes/auth.routes'));
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('an owner changes their MPIN: the new one signs in, the old one does not, and Forgot MPIN shows the new one', async () => {
  const { owner } = accounts;
  const { status, body } = await changeMpin(ownerToken(owner), '1111', '0827');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, { success: true, message: 'MPIN updated.' });

  const stored = await BusinessUser.findById(owner._id).select('+mpinVault').lean();
  assert.equal(await bcrypt.compare('0827', stored.mpinHash), true);
  assert.equal(openMpin(stored.mpinVault), '0827', 'the sealed copy is the new MPIN');
  assert.equal(stored.passwordHash, stored.mpinHash, 'the password column holding the MPIN moves with it');

  assert.equal((await login('9000000001', '1111')).status, 401, 'the old MPIN no longer signs in');
  // Nor through the password an older build sends.
  assert.equal((await api('POST', '/auth/login', { body: { mobile: '9000000001', password: '1111' } })).status, 401);
  const signedIn = await login('9000000001', '0827');
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.data.role, 'OWNER');

  // Forgot MPIN end to end: the OTP gives a reset token, which reveals the
  // MPIN in force.
  const verified = await api('POST', '/auth/forgot-password/verify-otp', {
    body: { identifier: '9000000001', otp: '123456' },
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const revealed = await api('POST', '/auth/forgot-password/reveal-mpin', {
    body: { resetToken: verified.body.data.resetToken },
  });
  assert.equal(revealed.status, 200, JSON.stringify(revealed.body));
  assert.equal(revealed.body.data.mpin, '0827');
});

test('an owner with a password of their own keeps it; only the MPIN changes', async () => {
  const { withPassword } = accounts;
  assert.equal((await changeMpin(ownerToken(withPassword), '4444', '5555')).status, 200);

  assert.equal((await login('9000000004', '4444')).status, 401);
  assert.equal((await login('9000000004', '5555')).status, 200);
  const byPassword = await api('POST', '/auth/login', { body: { mobile: 'oldshop', password: 'secret123' } });
  assert.equal(byPassword.status, 200, 'the User ID and password still sign in');
});

test('an employee changes their own MPIN on their sign-in record; the owner reads the new one back', async () => {
  const { employee, owner } = accounts;
  const ownerBefore = await BusinessUser.findById(owner._id).lean();

  const { status, body } = await changeMpin(employeeToken(employee), '0451', '7319');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, { success: true, message: 'MPIN updated.' });

  const account = await BusinessUser.findOne({ employeeId: employee._id, role: 'EMP' }).select('+mpinVault').lean();
  assert.equal(await bcrypt.compare('7319', account.mpinHash), true);
  assert.equal(openMpin(account.mpinVault), '7319');
  assert.equal(account.passwordHash, undefined, 'an EMP record still has no password');
  assert.equal(await employeeAccounts.readMpinOf(employee), '7319', "the owner's Show MPIN reads the new one");

  assert.equal((await login('9811100001', '0451')).status, 401, 'the old MPIN no longer signs in');
  const signedIn = await login('9811100001', '7319');
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.data.role, 'EMP');
  assert.equal(signedIn.body.data.userId, String(employee._id));

  const ownerAfter = await BusinessUser.findById(owner._id).lean();
  assert.equal(ownerAfter.mpinHash, ownerBefore.mpinHash, "the owner's MPIN is untouched");
});

test('every refusal carries its code and the design copy, and changes nothing', async () => {
  const { recovering } = accounts;
  const token = ownerToken(recovering);
  const refused = (error, message) => ({ success: false, error, message });
  const before = (await BusinessUser.findById(recovering._id).lean()).mpinHash;

  const invalid = refused('MPIN_INVALID', 'Enter a 4-digit MPIN');
  for (const [label, body] of [
    ['a short current MPIN', { currentMpin: '333', newMpin: '1234', confirmMpin: '1234' }],
    ['a long new MPIN', { currentMpin: '3333', newMpin: '12345', confirmMpin: '12345' }],
    ['letters', { currentMpin: '3333', newMpin: 'abcd', confirmMpin: 'abcd' }],
    ['a number, which loses its leading zero', { currentMpin: '3333', newMpin: 1234, confirmMpin: 1234 }],
    ['a missing confirmation', { currentMpin: '3333', newMpin: '1234' }],
    ['nothing at all', {}],
  ]) {
    const { status, body: answer } = await api('POST', '/auth/change-mpin', { token, body });
    assert.equal(status, 400, label);
    assert.deepEqual(answer, invalid, label);
  }

  const mismatch = await changeMpin(token, '3333', '1234', '1243');
  assert.equal(mismatch.status, 400);
  assert.deepEqual(mismatch.body, refused('MPIN_MISMATCH', "MPINs don't match"));

  const incorrect = await changeMpin(token, '9999', '1234');
  assert.equal(incorrect.status, 400);
  assert.deepEqual(incorrect.body, refused('MPIN_INCORRECT', 'Incorrect MPIN.'));

  const same = await changeMpin(token, '3333', '3333');
  assert.equal(same.status, 400);
  assert.deepEqual(same.body, refused('MPIN_SAME', 'Choose an MPIN different from the current one'));

  assert.equal((await BusinessUser.findById(recovering._id).lean()).mpinHash, before, 'nothing was written');
  assert.equal((await login('9000000003', '3333')).status, 200, 'the MPIN still signs in');

  // Signed out, and an employee whose owner never gave them an MPIN.
  assert.equal((await api('POST', '/auth/change-mpin', { body: { currentMpin: '3333', newMpin: '1234', confirmMpin: '1234' } })).status, 401);
  const noMpin = await changeMpin(employeeToken(accounts.passwordEmployee), '1234', '5678');
  assert.equal(noMpin.status, 409);
  assert.equal(noMpin.body.error, 'EMPLOYEE_MPIN_NOT_SET');
});

test('five wrong current MPINs lock the change for that account only; a right one before then clears the count', async () => {
  const { lockout, recovering } = accounts;
  const token = ownerToken(lockout);

  // Four wrong, then the right one (refused only as the same MPIN): proved,
  // so the count starts again.
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await changeMpin(token, '0000', '1234')).body.error, 'MPIN_INCORRECT');
  }
  assert.equal((await changeMpin(token, '2222', '2222')).body.error, 'MPIN_SAME');

  for (let i = 0; i < 5; i += 1) {
    const wrong = await changeMpin(token, '0000', '1234');
    assert.equal(wrong.status, 400, `wrong attempt ${i + 1}`);
    assert.equal(wrong.body.error, 'MPIN_INCORRECT');
  }
  // The sixth is refused before it is compared, even with the right MPIN.
  const locked = await changeMpin(token, '2222', '1234');
  assert.equal(locked.status, 429);
  assert.deepEqual(locked.body, {
    success: false,
    error: 'MPIN_ATTEMPTS_EXCEEDED',
    message: 'Too many wrong MPIN attempts. Please try again in 15 minutes.',
  });
  assert.equal(await bcrypt.compare('2222', (await BusinessUser.findById(lockout._id).lean()).mpinHash), true);

  // Requests sent all at once get no more comparisons between them.
  const burst = await Promise.all(Array.from({ length: 5 }, () => changeMpin(token, '0000', '1234')));
  assert.ok(burst.every((answer) => answer.status === 429));

  // Another account is not affected, and the locked one still signs in.
  assert.equal((await changeMpin(ownerToken(recovering), '3333', '3434')).status, 200);
  assert.equal((await login('9000000002', '2222')).status, 200);
});

test('a burst of wrong guesses from a fresh account is held to five comparisons', async () => {
  const fresh = await createOwner('9000000005', '6666');
  const token = ownerToken(fresh);
  const answers = await Promise.all(Array.from({ length: 12 }, () => changeMpin(token, '0000', '1234')));
  const statuses = answers.map((answer) => answer.status).sort();
  assert.equal(statuses.filter((status) => status === 400).length, 5);
  assert.equal(statuses.filter((status) => status === 429).length, 7);
});

test('a sign-in comparing the old MPIN while it is changed does not seal the old one back', async () => {
  // No sealed copy yet, so the sign-in would write one.
  const owner = await createOwner('9000000006', '1212');
  const hold = holdNextCompare('1212');
  try {
    const signingIn = login('9000000006', '1212');
    await hold.atCompare;
    assert.equal((await changeMpin(ownerToken(owner), '1212', '3434')).status, 200);
    hold.release();
    assert.equal((await signingIn).status, 200, 'the MPIN was the one in force when that sign-in read it');
  } finally {
    hold.restore();
  }
  assert.equal(await sealedMpinOf(owner._id), '3434', 'Forgot MPIN shows the MPIN that signs in');
  assert.equal((await login('9000000006', '3434')).status, 200);

  // The same for an employee's sign-in.
  const employee = await Employee.create({ businessId: shop.id, name: 'Meena', phone: '9811100003' });
  await employeeAccounts.createAccountFor(employee, { mpin: '2468' });
  await BusinessUser.updateOne({ employeeId: employee._id }, { $unset: { mpinVault: 1 } });
  const employeeHold = holdNextCompare('2468');
  try {
    const signingIn = login('9811100003', '2468');
    await employeeHold.atCompare;
    assert.equal((await changeMpin(employeeToken(employee), '2468', '8642')).status, 200);
    employeeHold.release();
    assert.equal((await signingIn).status, 200);
  } finally {
    employeeHold.restore();
  }
  assert.equal(await employeeAccounts.readMpinOf(employee), '8642', "the owner's Show MPIN reads the MPIN in force");

  // And for the Profile screen's MPIN check.
  const editor = await createOwner('9000000008', '1357');
  const editHold = holdNextCompare('1357');
  try {
    const starting = profileEditService.startProfileEdit({ businessId: shop.id, userId: editor._id }, '1357');
    await editHold.atCompare;
    assert.equal((await changeMpin(ownerToken(editor), '1357', '7531')).status, 200);
    editHold.release();
    assert.ok((await starting).editToken);
  } finally {
    editHold.restore();
  }
  assert.equal(await sealedMpinOf(editor._id), '7531');
});

test('with nothing changing it, a sign-in still seals an MPIN that has no readable copy', async () => {
  const owner = await createOwner('9000000007', '5656');
  assert.equal(await sealedMpinOf(owner._id), null);
  assert.equal((await login('9000000007', '5656')).status, 200);
  assert.equal(await sealedMpinOf(owner._id), '5656');

  const employee = await Employee.create({ businessId: shop.id, name: 'Kiran', phone: '9811100004' });
  await employeeAccounts.createAccountFor(employee, { mpin: '1928' });
  await BusinessUser.updateOne({ employeeId: employee._id }, { $unset: { mpinVault: 1 } });
  assert.equal(await employeeAccounts.readMpinOf(employee), null);
  assert.equal((await login('9811100004', '1928')).status, 200);
  assert.equal(await employeeAccounts.readMpinOf(employee), '1928');

  const editor = await createOwner('9000000011', '3030');
  assert.ok((await profileEditService.startProfileEdit({ businessId: shop.id, userId: editor._id }, '3030')).editToken);
  assert.equal(await sealedMpinOf(editor._id), '3030');
});

test('an EXPIRE lost after its INCR takes the counter with it, so no lock is left without its window', async () => {
  const account = await createOwner('9000000009', '9090');
  const token = ownerToken(account);
  const key = `change_mpin_attempts:${account._id}`;

  const originalExpire = redisClient.expire;
  redisClient.expire = async () => { throw new Error('Connection is closed.'); };
  try {
    assert.equal((await changeMpin(token, '0000', '1234')).status, 500);
  } finally {
    redisClient.expire = originalExpire;
  }
  assert.equal(await redisClient.get(key), null, 'the counter went rather than stay without a TTL');

  // The count starts again, with its window.
  assert.equal((await changeMpin(token, '0000', '1234')).body.error, 'MPIN_INCORRECT');
  assert.equal(await redisClient.get(key), '1');
  const ttl = await redisClient.ttl(key);
  assert.ok(ttl > 0 && ttl <= 15 * 60, `TTL ${ttl}`);
});

test('a lock found without a TTL gets its window back, and the refusal says how long is left', async () => {
  const account = await createOwner('9000000010', '1010');
  const token = ownerToken(account);
  const key = `change_mpin_attempts:${account._id}`;
  const lockedFor = (minutes) => ({
    success: false,
    error: 'MPIN_ATTEMPTS_EXCEEDED',
    message: `Too many wrong MPIN attempts. Please try again in ${minutes}.`,
  });

  // Five attempts counted and no TTL (an EXPIRE and its clean-up both lost).
  await redisClient.set(key, '5');
  assert.equal(await redisClient.ttl(key), -1);
  const healed = await changeMpin(token, '1010', '1234');
  assert.equal(healed.status, 429);
  assert.deepEqual(healed.body, lockedFor('15 minutes'));
  const ttl = await redisClient.ttl(key);
  assert.ok(ttl > 0 && ttl <= 15 * 60, `the window runs from now (TTL ${ttl})`);

  // Part of the window gone: the minutes that are left, not fifteen.
  await redisClient.set(key, '5', 'EX', 90);
  assert.deepEqual((await changeMpin(token, '1010', '1234')).body, lockedFor('2 minutes'));
  await redisClient.set(key, '5', 'EX', 20);
  assert.deepEqual((await changeMpin(token, '1010', '1234')).body, lockedFor('1 minute'));

  // Once the window is over, the right MPIN changes it.
  await redisClient.del(key);
  assert.equal((await changeMpin(token, '1010', '1234')).status, 200);
});

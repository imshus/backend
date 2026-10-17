/**
 * Deleting one's own account (Settings → Delete Account).
 *
 * The owner's call: remove the login, keep the data. POST
 * /auth/account/delete-otp texts a code to the caller's own phone; DELETE
 * /auth/account with that code and the word DELETE archives the caller's
 * business_users record whole in released_logins (reason ACCOUNT_DELETED) and
 * takes it out, and switches an employee off on the roster. The shop —
 * business, invoices, scans, wallet, credits, payments, licence, its other
 * owners and employees — is never touched, and
 * scripts/restore_released_login.js puts the login back.
 *
 * Runs the real routes, the real otp.service and a real (in-memory) MongoDB.
 * MSG91 is stubbed exactly as in employeePhoneOtp.test.js: no SMS leaves this
 * process, and no other network call is allowed.
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

const axios = require('axios');
const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Business = require('../src/models/business.model');
const BusinessUser = require('../src/models/businessUser.model');
const Employee = require('../src/models/employee.model');
const OrganizationLicense = require('../src/models/organizationLicense.model');
const OtpVerification = require('../src/models/otpVerification.model');
const ReleasedLogin = require('../src/models/releasedLogin.model');
const authService = require('../src/services/auth.service');
const employeeAccounts = require('../src/services/employeeAccount.service');
const otpService = require('../src/services/otp.service');
const errorHandler = require('../src/middleware/errorHandler');
const { authenticateJWT, requireRole } = require('../src/middleware/auth.middleware');
const { sealMpin } = require('../src/utils/mpinVault');
const { normalizeIndianMobile } = require('../src/utils/phone');
const { signEmployeePhoneToken } = require('../src/utils/employeePhoneToken');
const { restoreReleasedLogin } = require('../scripts/restore_released_login');

// MSG91, stubbed. `mode` decides its answer; any other host is a test bug.
const msg91 = { mode: 'ok', sent: [] };
axios.post = async (url, payload, options = {}) => {
  if (!String(url).startsWith('https://control.msg91.com/')) {
    throw new Error(`Unexpected network call in a test: ${url}`);
  }
  msg91.sent.push({ mobile: options.params?.mobile, otp: payload?.otp });
  if (msg91.mode === 'reject') {
    return { status: 200, data: { type: 'error', message: 'Template not approved' } };
  }
  return { status: 200, data: { type: 'success', request_id: `req-${msg91.sent.length}` } };
};

const lastCodeTo = (phone) => {
  const mobile = `91${normalizeIndianMobile(phone)}`;
  return [...msg91.sent].reverse().find((sms) => sms.mobile === mobile)?.otp;
};

// The [ACCOUNT_DELETED] lines (and the transfer ones, for the roster adds),
// kept out of the test output and read back.
const releaseLog = [];
const realInfo = console.info;
const realError = console.error;
const isReleaseLine = (args) => /^\[(ACCOUNT_DELETED|EMPLOYEE_TRANSFER)\]/.test(String(args[0]));
console.info = (...args) => (isReleaseLine(args) ? releaseLog.push(args) : realInfo(...args));
console.error = (...args) => (isReleaseLine(args) ? releaseLog.push(args) : realError(...args));

let mongoServer;
let server;
let baseUrl;

const DELETED = { success: true, message: 'Your account has been deleted.' };
const shopA = { id: new mongoose.Types.ObjectId() };
const shopB = { id: new mongoose.Types.ObjectId() };
const created = {};

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

const tokensOf = (businessId, userId, role) => authService.generateTokens(String(businessId), String(userId), role);
const ownerToken = (shop, ownerId = shop.ownerId) => tokensOf(shop.id, ownerId, 'OWNER').accessToken;

const sendCode = (token) => api('POST', '/auth/account/delete-otp', { token, body: {} });
const deleteAccount = (token, body) => api('DELETE', '/auth/account', { token, body });
const login = (mobile, mpin) => api('POST', '/auth/login', { body: { mobile, mpin } });
const refresh = (refreshToken) => api('POST', '/auth/refresh', { body: { refreshToken } });

const rawLogin = (filter) => BusinessUser.collection.findOne(filter);
const plain = (value) => JSON.parse(JSON.stringify(value));

async function counts() {
  const [employees, users, released] = await Promise.all([
    Employee.countDocuments(),
    BusinessUser.countDocuments(),
    ReleasedLogin.countDocuments(),
  ]);
  return { employees, users, released };
}

/**
 * Everything a shop has outside its sign-in records, as stored: the business,
 * its employees, invoices, scans, wallet, credits, payments, licence and
 * subscription. (The codes it sent are its own bookkeeping and change.)
 */
async function shopData(shopId) {
  const out = {};
  const skip = new Set(['business_users', 'otp_verifications', 'released_logins']);
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    if (skip.has(name)) continue;
    const docs = await mongoose.connection.db.collection(name)
      .find({ $or: [{ businessId: shopId }, { _id: shopId }] })
      .sort({ _id: 1 })
      .toArray();
    if (docs.length) out[name] = docs;
  }
  return plain(out);
}

/** Every sign-in record but the ones named, as stored. */
async function otherLogins(...exceptIds) {
  const docs = await BusinessUser.collection
    .find({ _id: { $nin: exceptIds } })
    .sort({ _id: 1 })
    .toArray();
  return plain(docs);
}

async function makeOwner(shop, { phone, mpin, gstNumber, name }) {
  const owner = await BusinessUser.create({
    businessId: shop.id,
    phone,
    fullName: `${name} Owner`,
    gstNumber,
    businessName: name,
    address: `${name}, Main Road`,
    mpinHash: await bcrypt.hash(mpin, 10),
    mpinVault: sealMpin(mpin),
    passwordHash: await bcrypt.hash(mpin, 10),
    role: 'OWNER',
  });
  return owner._id;
}

/** An employee of `shop` added the way the app adds one, MPIN and all. */
async function addEmployee(shop, phone, mpin, name) {
  const { status, body } = await api('POST', '/employees', {
    token: ownerToken(shop),
    body: {
      name,
      phone,
      designation: 'Sales',
      mpin,
      confirmMpin: mpin,
      phoneVerificationToken: signEmployeePhoneToken({ businessId: String(shop.id), phone }),
    },
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body.data.employee;
}

/** Sends a code with `token` and answers it, as the app reads it off the SMS. */
async function codeFor(token, phone) {
  const sent = await sendCode(token);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return lastCodeTo(phone);
}

test.before(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([BusinessUser.init(), Employee.init(), ReleasedLogin.init()]);

  await Business.create([
    {
      _id: shopA.id,
      gstNumber: '27AAAAA0000A1Z5',
      legalName: 'SHOP A',
      tradeName: 'Shop A',
      businessType: 'Retailer',
      gstStatus: 'Active',
      address: 'Shop A, Main Road',
      isRegistered: true,
    },
    {
      _id: shopB.id,
      gstNumber: '07BBBBB1111B1Z5',
      legalName: 'SHOP B',
      tradeName: 'Shop B',
      businessType: 'Retailer',
      gstStatus: 'Active',
      address: 'Shop B, Main Road',
      isRegistered: true,
    },
  ]);
  shopA.ownerId = await makeOwner(shopA, { phone: '9500000001', mpin: '1111', gstNumber: '27AAAAA0000A1Z5', name: 'Shop A' });
  shopA.secondOwnerId = await makeOwner(shopA, { phone: '9500000011', mpin: '1212', gstNumber: '27AAAAA0000A1Z5', name: 'Shop A' });
  shopB.ownerId = await makeOwner(shopB, { phone: '9500000002', mpin: '2222', gstNumber: '07BBBBB1111B1Z5', name: 'Shop B' });
  await OrganizationLicense.create([
    { businessId: shopA.id, ownerUserId: shopA.ownerId, ownerPhone: '9500000001', licenseStatus: 'PERMANENT_LICENSE' },
    { businessId: shopB.id, ownerUserId: shopB.ownerId, ownerPhone: '9500000002', licenseStatus: 'PERMANENT_LICENSE' },
  ]);

  // Shop A's work, which no deletion may touch.
  const db = mongoose.connection.db;
  await db.collection('invoices').insertOne({ businessId: shopA.id, invoiceNumber: 'A-0001', grandTotal: 125000 });
  await db.collection('scan_billing').insertOne({ businessId: shopA.id, scanId: 'scan-a-1', credits: 1 });
  await db.collection('organization_wallets').insertOne({ businessId: shopA.id, balanceCredits: 940 });
  await db.collection('credit_transactions').insertOne({ businessId: shopA.id, credits: 1000, type: 'PURCHASE' });
  await db.collection('payment_transactions').insertOne({ businessId: shopA.id, amount: 4999, status: 'CAPTURED' });
  await db.collection('organization_subscriptions').insertOne({ businessId: shopA.id, plan: 'PRO', status: 'ACTIVE' });

  // A SUPER account, signing in with a number of its own.
  const superUser = await BusinessUser.create({
    businessId: new mongoose.Types.ObjectId(),
    phone: '9500000099',
    passwordHash: await bcrypt.hash('super', 10),
    role: 'SUPER',
  });
  created.super = superUser;

  // Shop A's employee from before sign-in records.
  created.legacy = await Employee.create({ businessId: shopA.id, name: 'Legacy Karigar', phone: '09500000029' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', require('../src/routes/auth.routes'));
  app.use('/api/v1/employees', require('../src/routes/employee.routes'));
  app.use('/api/v1/settings', require('../src/routes/settings.routes'));
  // What every SUPER-only route checks first (/subscription/credits/*,
  // /settings/supreme-rates), with nothing behind it.
  app.post('/api/v1/probe/super-only', authenticateJWT, requireRole('SUPER'), (req, res) => res.json({ success: true }));
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  created.staff1 = await addEmployee(shopA, '9500000021', '2121', 'Staff One');
  created.staff2 = await addEmployee(shopA, '9500000022', '2222', 'Staff Two');
});

test.after(async () => {
  console.info = realInfo;
  console.error = realError;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('the code goes to the caller\'s own phone, masked in the answer and never in it', async () => {
  msg91.mode = 'ok';
  assert.equal((await sendCode(null)).status, 401, 'signed in only');

  const before = msg91.sent.length;
  const { status, body } = await sendCode(ownerToken(shopA));
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, {
    success: true,
    data: { phoneMasked: '+91 •••••00001', expiresInSeconds: 600, resendAfterSeconds: 30 },
  });
  assert.equal(msg91.sent.length, before + 1, 'one SMS');
  assert.equal(msg91.sent.at(-1).mobile, '919500000001', 'to the owner\'s own phone');
  const code = lastCodeTo('9500000001');
  assert.match(code, /^[0-9]{6}$/);
  assert.equal(JSON.stringify(body).includes(code), false, 'the code goes to the phone only');

  const record = await OtpVerification.findOne({ mobile: '9500000001' }).sort({ createdAt: -1 }).lean();
  assert.equal(record.flow, 'ACCOUNT_DELETE');
  assert.equal(record.otpType, 'PHONE');
  assert.equal(String(record.businessId), String(shopA.id));

  // An employee's goes to the number they sign in with.
  const staff = tokensOf(shopA.id, created.staff1._id, 'EMP').accessToken;
  const forStaff = await sendCode(staff);
  assert.equal(forStaff.status, 200, JSON.stringify(forStaff.body));
  assert.equal(forStaff.body.data.phoneMasked, '+91 •••••00021');
  assert.equal(msg91.sent.at(-1).mobile, '919500000021');
});

test('the deletion code is never printed, nor kept for the development OTP endpoint', async () => {
  const printed = [];
  const realLog = console.log;
  console.log = (...args) => printed.push(args.map(String).join(' '));
  let sent;
  try {
    sent = await sendCode(tokensOf(shopA.id, created.staff2._id, 'EMP').accessToken);
  } finally {
    console.log = realLog;
  }
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const code = lastCodeTo('9500000022');
  assert.match(code, /^[0-9]{6}$/);
  assert.ok(printed.some((line) => line.startsWith('Generated OTP:')), 'the send is still logged');
  assert.equal(printed.some((line) => line.includes(code)), false, 'without its code');
  assert.equal(Object.values(otpService.getDevOtps(String(shopA.id))).includes(code), false);
  assert.equal(Object.values(otpService.getDevOtps('9500000022')).includes(code), false);
});

test('MSG91 refusing the send is a 502 OTP_SEND_FAILED', async () => {
  msg91.mode = 'reject';
  try {
    const { status, body } = await sendCode(ownerToken(shopB));
    assert.equal(status, 502);
    assert.deepEqual(body, {
      success: false,
      error: 'OTP_SEND_FAILED',
      message: "Couldn't send the OTP right now. Please try again.",
    });
  } finally {
    msg91.mode = 'ok';
  }
});

test('nothing is deleted without DELETE typed exactly and this caller\'s latest unused code', async () => {
  const token = ownerToken(shopA, shopA.secondOwnerId);
  const before = await counts();

  // No code sent yet, or only codes that are not this caller's deletion code:
  // another shop's for the same number, a sign-in code, an employee-phone code.
  await OtpVerification.create([
    { businessId: shopB.id, otpType: 'PHONE', mobile: '9500000011', otp: '654321', flow: 'ACCOUNT_DELETE', expiresAt: new Date(Date.now() + 600000) },
    { otpType: 'MOBILE', mobile: '9500000011', otp: '111222', flow: 'GENERAL', expiresAt: new Date(Date.now() + 600000) },
    { businessId: shopA.id, otpType: 'PHONE', mobile: '9500000011', otp: '333444', flow: 'EMPLOYEE_PHONE', expiresAt: new Date(Date.now() + 600000) },
  ]);
  for (const otp of ['654321', '111222', '333444']) {
    const { status, body } = await deleteAccount(token, { otp, confirm: 'DELETE' });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.error, 'OTP_NOT_FOUND');
    assert.equal(body.message, 'Send an OTP to your phone first.');
  }

  const code = await codeFor(token, '9500000011');

  // The word, exactly. (Every try counts against the fifteen an hour.)
  for (const confirm of [undefined, 'delete', ' DELETE', 'DELETED']) {
    const { status, body } = await deleteAccount(token, { otp: code, confirm });
    assert.equal(status, 400, `confirm ${JSON.stringify(confirm)}`);
    assert.deepEqual(body, {
      success: false,
      error: 'CONFIRMATION_REQUIRED',
      message: 'Type DELETE in capital letters to confirm.',
    });
  }
  // Refused before the code is looked at: it is still unused.
  const stored = await OtpVerification.findOne({ mobile: '9500000011', flow: 'ACCOUNT_DELETE', businessId: shopA.id })
    .sort({ createdAt: -1 })
    .lean();
  assert.equal(stored.otp, code);
  assert.equal(stored.verified, false, 'a mistyped word does not use up the code');

  // A wrong code, a malformed one, or none.
  const wrong = code === '000000' ? '000001' : '000000';
  for (const otp of [wrong, '12', undefined]) {
    const { status, body } = await deleteAccount(token, { otp, confirm: 'DELETE' });
    assert.equal(status, 400, `otp ${JSON.stringify(otp)}`);
    assert.deepEqual(body, { success: false, error: 'OTP_INVALID', message: 'That OTP is not correct.' });
  }

  // The deletion code never signs anyone in.
  const signIn = await api('POST', '/auth/login-otp', { body: { mobile: '9500000011', otp: code } });
  assert.notEqual(signIn.status, 200);
  assert.equal(signIn.body.data, undefined);

  // Past its ten minutes.
  await OtpVerification.updateOne(
    { mobile: '9500000011', flow: 'ACCOUNT_DELETE', businessId: shopA.id },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  const expired = await deleteAccount(token, { otp: code, confirm: 'DELETE' });
  assert.equal(expired.status, 400);
  assert.deepEqual(expired.body, { success: false, error: 'OTP_EXPIRED', message: 'This OTP has expired. Send a new one.' });

  assert.deepEqual(await counts(), before, 'nothing written');
  assert.ok(await BusinessUser.exists({ _id: shopA.secondOwnerId }));
});

test('a deletion that fails part-way puts the login back, and its code cannot be used again', async () => {
  const token = ownerToken(shopA, shopA.secondOwnerId);
  const original = await rawLogin({ _id: shopA.secondOwnerId });
  const code = await codeFor(token, '9500000011');

  const realArchive = employeeAccounts.archiveRelease;
  employeeAccounts.archiveRelease = async (...args) => {
    await realArchive(...args);
    throw new Error('disk full');
  };
  try {
    assert.equal((await deleteAccount(token, { otp: code, confirm: 'DELETE' })).status, 500);
  } finally {
    employeeAccounts.archiveRelease = realArchive;
  }
  assert.deepEqual(plain(await rawLogin({ _id: shopA.secondOwnerId })), plain(original), 'back exactly as it was');
  const entry = await ReleasedLogin.findOne({ 'original._id': shopA.secondOwnerId }).lean();
  assert.ok(entry.restoredAt instanceof Date, 'its entry says it went back');

  const again = await deleteAccount(token, { otp: code, confirm: 'DELETE' });
  assert.equal(again.status, 400);
  assert.deepEqual(again.body, {
    success: false,
    error: 'OTP_ALREADY_USED',
    message: 'This OTP was already used. Send a new one.',
  });
  assert.ok(await BusinessUser.exists({ _id: shopA.secondOwnerId }));
  await ReleasedLogin.deleteOne({ _id: entry._id });
});

test('an owner deleting their account loses their login only: the shop and everyone else in it stay', async () => {
  const session = tokensOf(shopA.id, shopA.ownerId, 'OWNER');
  const original = await rawLogin({ _id: shopA.ownerId });
  assert.ok(original.mpinVault && original.mpinHash && original.passwordHash, 'the record as stored, sealed MPIN included');
  const shopBefore = await shopData(shopA.id);
  assert.ok(shopBefore.invoices && shopBefore.organization_wallets && shopBefore.credit_transactions);
  assert.ok(shopBefore.payment_transactions && shopBefore.organization_licenses && shopBefore.employees);
  const othersBefore = await otherLogins(shopA.ownerId);
  const shopBBefore = await shopData(shopB.id);

  const code = await codeFor(session.accessToken, '9500000001');
  // The word mistyped first: refused, and the same code still works after.
  const mistyped = await deleteAccount(session.accessToken, { otp: code, confirm: 'delete' });
  assert.equal(mistyped.body.error, 'CONFIRMATION_REQUIRED');
  releaseLog.length = 0;
  const { status, body } = await deleteAccount(session.accessToken, { otp: code, confirm: 'DELETE' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, DELETED);

  // Gone from business_users, archived whole.
  assert.equal(await BusinessUser.exists({ _id: shopA.ownerId }), null);
  const entries = await ReleasedLogin.find({ phone: '9500000001' }).lean();
  assert.equal(entries.length, 1);
  const [entry] = entries;
  created.ownerEntry = entry;
  assert.equal(entry.reason, 'ACCOUNT_DELETED');
  assert.equal(entry.kind, 'owner');
  assert.equal(String(entry.fromBusinessId), String(shopA.id));
  assert.equal(String(entry.releasedByBusinessId), String(shopA.id));
  assert.equal(entry.releasedByUserId, String(shopA.ownerId));
  assert.equal(entry.employeeId, null);
  assert.equal(entry.previousIsActive, null);
  assert.equal(entry.restoredAt, null);
  assert.deepEqual(plain(entry.original), plain(original));
  assert.equal(entry.original.mpinVault, original.mpinVault);

  // Nothing else: the shop's data, the second owner, the employees and their
  // sign-ins, the other shop.
  assert.deepEqual(await shopData(shopA.id), shopBefore, 'business, invoices, scans, wallet, credits, payments, licence, employees');
  assert.deepEqual(await otherLogins(shopA.ownerId), othersBefore, 'every other sign-in record as it was');
  assert.deepEqual(await shopData(shopB.id), shopBBefore);

  // One log line, ids only.
  assert.equal(releaseLog.length, 1);
  assert.deepEqual(releaseLog[0], ['[ACCOUNT_DELETED]', {
    kind: 'owner',
    fromBusinessId: String(shopA.id),
    releasedLoginId: String(shopA.ownerId),
    employeeId: null,
    releasedId: String(entry._id),
  }]);
  const logged = JSON.stringify(releaseLog);
  for (const secret of [code, original.mpinHash, original.mpinVault, original.passwordHash]) {
    assert.equal(logged.includes(secret), false, 'no codes or hashes in the log');
  }

  // Their sessions are over: refresh, the routes behind requireCurrentOwner,
  // signing in again.
  assert.equal((await refresh(session.refreshToken)).status, 401);
  assert.equal((await sendCode(session.accessToken)).status, 401);
  assert.equal((await deleteAccount(session.accessToken, { otp: code, confirm: 'DELETE' })).status, 401);
  assert.equal((await api('GET', '/employees/check-phone?phone=9500000077', { token: session.accessToken })).status, 401);
  assert.equal((await login('9500000001', '1111')).status, 401);

  // The second owner carries on.
  assert.equal((await api('GET', '/employees/check-phone?phone=9500000077', { token: ownerToken(shopA, shopA.secondOwnerId) })).status, 200);
  assert.equal((await login('9500000011', '1212')).status, 200);
});

test('an employee deleting their account: their sign-in archived, switched off, everyone else untouched', async () => {
  const signedIn = await login('9500000021', '2121');
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  const { accessToken, refreshToken, role } = signedIn.body.data;
  assert.equal(role, 'EMP');
  const staffId = created.staff1._id;
  const original = await rawLogin({ employeeId: new mongoose.Types.ObjectId(staffId) });
  assert.ok(original);
  const employeeBefore = plain(await Employee.findById(staffId).lean());
  const othersBefore = await otherLogins(original._id);
  const otherEmployeesBefore = plain(await Employee.find({ _id: { $ne: staffId } }).sort({ _id: 1 }).lean());
  const shopBefore = await shopData(shopA.id);

  const code = await codeFor(accessToken, '9500000021');
  releaseLog.length = 0;
  const { status, body } = await deleteAccount(accessToken, { otp: code, confirm: 'DELETE' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, DELETED);

  // The EMP record is archived and gone; the roster entry is switched off and
  // otherwise as it was.
  assert.equal(await BusinessUser.exists({ _id: original._id }), null);
  const entry = await ReleasedLogin.findOne({ phone: '9500000021' }).lean();
  created.staffEntry = entry;
  assert.equal(entry.reason, 'ACCOUNT_DELETED');
  assert.equal(entry.kind, 'employee');
  assert.equal(String(entry.employeeId), staffId);
  assert.equal(entry.previousIsActive, true);
  assert.equal(String(entry.fromBusinessId), String(shopA.id));
  assert.equal(entry.releasedByUserId, staffId);
  assert.deepEqual(plain(entry.original), plain(original));
  // (sessionVersion moves on: the sessions from before stay over, see below.)
  const { sessionVersion, ...employeeAfter } = plain(await Employee.findById(staffId).lean());
  assert.equal(employeeAfter.isActive, false);
  assert.equal(sessionVersion, 1);
  assert.deepEqual({ ...employeeAfter, isActive: true, updatedAt: null }, { ...employeeBefore, updatedAt: null });

  // The owner, the other employee and their sign-ins: as they were.
  assert.deepEqual(await otherLogins(original._id), othersBefore);
  assert.deepEqual(plain(await Employee.find({ _id: { $ne: staffId } }).sort({ _id: 1 }).lean()), otherEmployeesBefore);
  const { employees: employeesBefore, ...restBefore } = shopBefore;
  const { employees: employeesAfter, ...restAfter } = await shopData(shopA.id);
  assert.deepEqual(restAfter, restBefore, 'business, invoices, scans, wallet, credits, payments, licence');
  assert.equal(employeesAfter.length, employeesBefore.length, 'no employee removed');
  assert.equal(releaseLog.length, 1);
  assert.equal(releaseLog[0][0], '[ACCOUNT_DELETED]');

  // Their sessions are over.
  assert.equal((await refresh(refreshToken)).status, 401);
  assert.equal((await sendCode(accessToken)).status, 401);
  assert.equal((await login('9500000021', '2121')).status, 401);
  assert.equal((await login('9500000022', '2222')).status, 200, 'the other employee still signs in');
});

test('an employee from before sign-in records: switching them off is the whole release', async () => {
  const token = tokensOf(shopA.id, created.legacy._id, 'EMP');
  const sent = await sendCode(token.accessToken);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.data.phoneMasked, '+91 •••••00029');
  const before = await counts();

  const { status, body } = await deleteAccount(token.accessToken, { otp: lastCodeTo('9500000029'), confirm: 'DELETE' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal((await Employee.findById(created.legacy._id).lean()).isActive, false);
  const entry = await ReleasedLogin.findOne({ employeeId: created.legacy._id }).lean();
  created.legacyEntry = entry;
  assert.equal(entry.reason, 'ACCOUNT_DELETED');
  assert.equal(entry.original, null);
  assert.equal(entry.phone, '9500000029');
  assert.equal(entry.previousIsActive, true);
  assert.deepEqual(await counts(), { ...before, released: before.released + 1 });
  assert.equal((await refresh(token.refreshToken)).status, 401);
});

test('a roster number typed with spaces or dashes still gets the code; the release goes by id', async () => {
  for (const [phone, tenDigits] of [['95000 00031', '9500000031'], ['+91-95000-00032', '9500000032']]) {
    const employee = await Employee.create({ businessId: shopA.id, name: `Karigar ${phone}`, phone });
    const token = tokensOf(shopA.id, employee._id, 'EMP');
    const sent = await sendCode(token.accessToken);
    assert.equal(sent.status, 200, `${phone}: ${JSON.stringify(sent.body)}`);
    assert.equal(sent.body.data.phoneMasked, `+91 •••••${tenDigits.slice(-5)}`);
    assert.equal(msg91.sent.at(-1).mobile, `91${tenDigits}`);

    const { status, body } = await deleteAccount(token.accessToken, { otp: lastCodeTo(tenDigits), confirm: 'DELETE' });
    assert.equal(status, 200, `${phone}: ${JSON.stringify(body)}`);
    const after = await Employee.findById(employee._id).lean();
    assert.equal(after.isActive, false);
    assert.equal(after.phone, phone, 'the roster entry otherwise as it was');
    const entry = await ReleasedLogin.findOne({ employeeId: employee._id }).lean();
    assert.equal(entry.reason, 'ACCOUNT_DELETED');
    assert.equal(entry.phone, tenDigits);
    assert.equal(entry.original, null);
    assert.equal(entry.previousIsActive, true);
    assert.equal((await refresh(token.refreshToken)).status, 401);

    // And the restore script switches them back on.
    assert.equal((await restoreReleasedLogin(String(entry._id))).restored, true);
    assert.equal((await Employee.findById(employee._id).lean()).isActive, true);
  }
});

test('an account with no usable phone number is told so in words for its role', async () => {
  const employee = await Employee.create({ businessId: shopA.id, name: 'No Number', phone: '12345' });
  const forEmployee = await sendCode(tokensOf(shopA.id, employee._id, 'EMP').accessToken);
  assert.equal(forEmployee.status, 409);
  assert.deepEqual(forEmployee.body, {
    success: false,
    error: 'ACCOUNT_PHONE_MISSING',
    message: 'There is no usable phone number on this account to send an OTP to. Ask your shop owner to update your number or remove you.',
  });

  const owner = await BusinessUser.create({ businessId: shopB.id, phone: '12345', passwordHash: 'x', role: 'OWNER' });
  const forOwner = await sendCode(ownerToken(shopB, owner._id));
  assert.equal(forOwner.status, 409);
  assert.deepEqual(forOwner.body, {
    success: false,
    error: 'ACCOUNT_PHONE_MISSING',
    message: 'There is no usable phone number on this account to send an OTP to. Please reach us through Contact Us.',
  });
  assert.equal(
    (await deleteAccount(ownerToken(shopB, owner._id), { otp: '123456', confirm: 'DELETE' })).body.error,
    'ACCOUNT_PHONE_MISSING',
  );
  assert.ok(await BusinessUser.exists({ _id: owner._id }), 'nothing written');
  await BusinessUser.deleteOne({ _id: owner._id });
});

test('an owner whose number was stored with a leading 0 gets the code on its ten digits', async () => {
  const { insertedId } = await BusinessUser.collection.insertOne({
    businessId: shopB.id,
    phone: '09500000033',
    passwordHash: 'x',
    role: 'OWNER',
    isActive: true,
  });
  const token = ownerToken(shopB, insertedId);
  const sent = await sendCode(token);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.data.phoneMasked, '+91 •••••00033');
  assert.equal(msg91.sent.at(-1).mobile, '919500000033');

  const { status, body } = await deleteAccount(token, { otp: lastCodeTo('9500000033'), confirm: 'DELETE' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(await BusinessUser.exists({ _id: insertedId }), null);
  const entry = await ReleasedLogin.findOne({ 'original._id': insertedId }).lean();
  assert.equal(entry.phone, '9500000033');
  assert.equal(entry.original.phone, '09500000033', 'archived as stored');
});

test('a SUPER account deleting itself: its login archived, its refresh and its SUPER routes refused', async () => {
  const session = tokensOf(created.super.businessId, created.super._id, 'SUPER');
  assert.equal((await refresh(session.refreshToken)).status, 200);
  const superOnly = () => api('POST', '/probe/super-only', { token: session.accessToken });
  assert.equal((await superOnly()).status, 200);
  assert.equal((await api('GET', '/employees', { token: session.accessToken })).status, 200);
  const code = await codeFor(session.accessToken, '9500000099');
  assert.deepEqual((await deleteAccount(session.accessToken, { otp: code, confirm: 'DELETE' })).body, DELETED);
  assert.equal(await BusinessUser.exists({ _id: created.super._id }), null);
  const entry = await ReleasedLogin.findOne({ phone: '9500000099' }).lean();
  assert.equal(entry.kind, 'owner');
  assert.equal(entry.original.role, 'SUPER');
  assert.equal((await refresh(session.refreshToken)).status, 401);
  assert.equal((await sendCode(session.accessToken)).status, 401);

  // Its access token, still unexpired, no longer passes as SUPER anywhere.
  const ended = { success: false, error: 'UNAUTHORIZED', message: 'Your session has ended. Please sign in again.' };
  assert.deepEqual(await superOnly(), { status: 401, body: ended });
  assert.deepEqual(await api('GET', '/settings/supreme-rates', { token: session.accessToken }), { status: 401, body: ended });
  assert.deepEqual(await api('GET', '/employees', { token: session.accessToken }), { status: 401, body: ended });
});

test('the restore script puts deleted accounts back as they were', async () => {
  // The owner: the record exactly as it was, signing in as before.
  const owner = await restoreReleasedLogin(String(created.ownerEntry._id));
  assert.equal(owner.restored, true);
  assert.equal(owner.kind, 'owner');
  assert.deepEqual(plain(await rawLogin({ _id: shopA.ownerId })), plain(created.ownerEntry.original));
  const ownerLogin = await login('9500000001', '1111');
  assert.equal(ownerLogin.status, 200);
  assert.equal(ownerLogin.body.data.role, 'OWNER');
  assert.equal(ownerLogin.body.data.businessId, String(shopA.id));
  assert.equal((await restoreReleasedLogin(String(created.ownerEntry._id))).reason, 'ALREADY_RESTORED');

  // The employee: switched back on, with their sign-in record.
  const staff = await restoreReleasedLogin(String(created.staffEntry._id));
  assert.equal(staff.restored, true);
  assert.equal((await Employee.findById(created.staff1._id).lean()).isActive, true);
  assert.deepEqual(plain(await rawLogin({ _id: created.staffEntry.original._id })), plain(created.staffEntry.original));
  const staffLogin = await login('9500000021', '2121');
  assert.equal(staffLogin.status, 200);
  assert.equal(staffLogin.body.data.role, 'EMP');
  assert.equal(staffLogin.body.data.userId, created.staff1._id);

  // The employee without a sign-in record: back on.
  assert.equal((await restoreReleasedLogin(String(created.legacyEntry._id))).restored, true);
  assert.equal((await Employee.findById(created.legacy._id).lean()).isActive, true);
});

test('an owner switching a deleted employee back on does not bring back their old sessions', async () => {
  const staff = await addEmployee(shopA, '9500000023', '2323', 'Staff Three');
  const signedIn = await login('9500000023', '2323');
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  const { accessToken, refreshToken } = signedIn.body.data;
  const code = await codeFor(accessToken, '9500000023');
  assert.deepEqual((await deleteAccount(accessToken, { otp: code, confirm: 'DELETE' })).body, DELETED);
  assert.equal((await refresh(refreshToken)).status, 401);
  const entry = await ReleasedLogin.findOne({ employeeId: staff._id, reason: 'ACCOUNT_DELETED' }).lean();

  // The owner switches them back on: a new sign-in record, no MPIN yet.
  const owner = ownerToken(shopA);
  const on = await api('PUT', `/employees/${staff._id}`, { token: owner, body: { isActive: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.data.isActive, true);
  assert.equal('sessionVersion' in on.body.data, false, 'not part of what the app is sent');
  assert.equal((await refresh(refreshToken)).status, 401, 'the session from before the deletion stays over');

  // With an MPIN from the owner, a new sign-in is a new session, refreshed as usual.
  const mpin = await api('PUT', `/employees/${staff._id}/mpin`, { token: owner, body: { mpin: '3434', confirmMpin: '3434' } });
  assert.equal(mpin.status, 200, JSON.stringify(mpin.body));
  const again = await login('9500000023', '3434');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const renewed = await refresh(again.body.data.refreshToken);
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.equal((await refresh(renewed.body.data.refreshToken)).status, 200);
  assert.equal((await refresh(refreshToken)).status, 401);

  // Their shop gave them a new sign-in record, so the archived one is not
  // put back over it: the restore script refuses, writing nothing.
  const restore = await restoreReleasedLogin(String(entry._id));
  assert.equal(restore.restored, false);
  assert.equal(restore.reason, 'EMPLOYEE_HAS_LOGIN');
  assert.equal((await ReleasedLogin.findById(entry._id).lean()).restoredAt, null);
});

test('codes and attempts are counted per account', async () => {
  const token = ownerToken(shopB);
  // One send was refused by MSG91 above; it still counted.
  for (let i = 0; i < 4; i += 1) assert.equal((await sendCode(token)).status, 200);
  const sixth = await sendCode(token);
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, 'RATE_LIMIT_EXCEEDED');
  assert.equal((await sendCode(ownerToken(shopA, shopA.secondOwnerId))).status, 200, 'another account has its own count');

  const code = lastCodeTo('9500000002');
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 15; i += 1) {
    assert.equal((await deleteAccount(token, { otp: wrong, confirm: 'DELETE' })).status, 400);
  }
  const refused = await deleteAccount(token, { otp: code, confirm: 'DELETE' });
  assert.equal(refused.status, 429);
  assert.ok(await BusinessUser.exists({ _id: shopB.ownerId }), 'still there');
  const other = await deleteAccount(tokensOf(shopA.id, created.staff2._id, 'EMP').accessToken, { otp: wrong, confirm: 'DELETE' });
  assert.equal(other.status, 400, 'another account has its own count');
  assert.ok(await BusinessUser.exists({ employeeId: new mongoose.Types.ObjectId(created.staff2._id) }));
});

/**
 * Making someone who already signs in elsewhere this shop's employee.
 *
 * The owner may not add their own number, a SUPER account's, or one of their
 * own employees'. Any other holder is moved here once the number is proved
 * with the OTP: another shop's owner (or a second owner of this shop) has
 * their sign-in record archived whole in released_logins and taken out of
 * business_users; another shop's employee is switched off there and their
 * sign-in record archived the same way. Their shop — business, invoices,
 * scans, wallet, licence — is never touched, and a failed add puts back
 * everything it moved. scripts/restore_released_login.js puts a record back.
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
const ReleasedLogin = require('../src/models/releasedLogin.model');
const authService = require('../src/services/auth.service');
const employeeAccounts = require('../src/services/employeeAccount.service');
const errorHandler = require('../src/middleware/errorHandler');
const { sealMpin } = require('../src/utils/mpinVault');
const { normalizeIndianMobile } = require('../src/utils/phone');
const { signEmployeePhoneToken } = require('../src/utils/employeePhoneToken');
const { restoreReleasedLogin } = require('../scripts/restore_released_login');

// MSG91, stubbed. Any other host is a test bug.
const msg91 = { sent: [] };
axios.post = async (url, payload, options = {}) => {
  if (!String(url).startsWith('https://control.msg91.com/')) {
    throw new Error(`Unexpected network call in a test: ${url}`);
  }
  msg91.sent.push({ mobile: options.params?.mobile, otp: payload?.otp });
  return { status: 200, data: { type: 'success', request_id: `req-${msg91.sent.length}` } };
};

const lastCodeTo = (phone) => {
  const mobile = `91${normalizeIndianMobile(phone)}`;
  return [...msg91.sent].reverse().find((sms) => sms.mobile === mobile)?.otp;
};

// The [EMPLOYEE_TRANSFER] lines, kept out of the test output and read back.
const transferLog = [];
const realInfo = console.info;
console.info = (...args) => {
  if (String(args[0]).startsWith('[EMPLOYEE_TRANSFER]')) {
    transferLog.push(args);
    return;
  }
  realInfo(...args);
};

let mongoServer;
let server;
let baseUrl;

const OWN_NUMBER = {
  success: false,
  error: 'OWN_NUMBER',
  message: "You can't add your own number as an employee.",
};
const PHONE_TAKEN = {
  success: false,
  error: 'PHONE_ALREADY_REGISTERED',
  message: 'This number is already registered',
};
const NOT_VERIFIED = {
  success: false,
  error: 'EMPLOYEE_PHONE_NOT_VERIFIED',
  message: "Verify the employee's phone number with the OTP sent to it. If you don't see an OTP step, update the MRPscan app.",
};

// Shop A adds; the others hold numbers it adds.
const shops = {};
const SUPER_PHONE = '9300000099';
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

const ownerToken = (shop, ownerId = shop.ownerId) =>
  authService.generateTokens(String(shop.id), String(ownerId), 'OWNER').accessToken;
const verified = (shop, phone) => signEmployeePhoneToken({ businessId: String(shop.id), phone });

const check = (shop, phone) =>
  api('GET', `/employees/check-phone?phone=${encodeURIComponent(phone)}`, { token: ownerToken(shop) });
const sendCode = (shop, phone) => api('POST', '/employees/phone-otp', { token: ownerToken(shop), body: { phone } });

/** The whole OTP round trip, as the app makes it. */
async function proveNumber(shop, phone) {
  const sent = await sendCode(shop, phone);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const checked = await api('POST', '/employees/phone-otp/verify', {
    token: ownerToken(shop),
    body: { phone, otp: lastCodeTo(phone) },
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  return { sent: sent.body, token: checked.body.data.phoneVerificationToken, otp: lastCodeTo(phone) };
}

const newEmployee = (phone, phoneVerificationToken, extra = {}) => ({
  name: 'Moved Person',
  phone,
  designation: 'Sales',
  mpin: '2580',
  confirmMpin: '2580',
  ...(phoneVerificationToken === undefined ? {} : { phoneVerificationToken }),
  ...extra,
});

const login = (mobile, mpin) => api('POST', '/auth/login', { body: { mobile, mpin } });
const refresh = (refreshToken) => api('POST', '/auth/refresh', { body: { refreshToken } });

/** A business_users record with every field, sealed MPIN and hashes included. */
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

/** Everything a shop owns outside business_users, as stored. */
async function shopData(shopId) {
  const out = {};
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    if (name === 'business_users') continue;
    const docs = await mongoose.connection.db.collection(name)
      .find({ $or: [{ businessId: shopId }, { _id: shopId }] })
      .sort({ _id: 1 })
      .toArray();
    if (docs.length) out[name] = docs;
  }
  return plain(out);
}

async function makeShop(key, { phone, mpin, gstNumber, name }) {
  const shop = { id: new mongoose.Types.ObjectId(), phone, mpin };
  await Business.create({
    _id: shop.id,
    gstNumber,
    legalName: name.toUpperCase(),
    tradeName: name,
    businessType: 'Retailer',
    gstStatus: 'Active',
    address: `${name}, Main Road`,
    isRegistered: true,
  });
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
  shop.ownerId = owner._id;
  await OrganizationLicense.create({
    businessId: shop.id, ownerUserId: owner._id, ownerPhone: phone, licenseStatus: 'PERMANENT_LICENSE',
  });
  shops[key] = shop;
  return shop;
}

/** An employee of `shop` added the way the app adds one, MPIN and all. */
async function addEmployee(shop, phone, mpin, name = 'Shop Staff') {
  const { status, body } = await api('POST', '/employees', {
    token: ownerToken(shop),
    body: newEmployee(phone, verified(shop, phone), { name, mpin, confirmMpin: mpin }),
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body.data.employee;
}

test.before(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([BusinessUser.init(), Employee.init(), ReleasedLogin.init()]);

  await makeShop('A', { phone: '9300000001', mpin: '1111', gstNumber: '27AAAAA0000A1Z5', name: 'Shop A' });
  await makeShop('B', { phone: '9300000002', mpin: '2222', gstNumber: '07BBBBB1111B1Z5', name: 'Shop B' });
  await makeShop('C', { phone: '9300000003', mpin: '3333', gstNumber: '29CCCCC2222C1Z5', name: 'Shop C' });
  await makeShop('D', { phone: '9300000004', mpin: '4444', gstNumber: '24DDDDD3333D1Z5', name: 'Shop D' });
  await makeShop('E', { phone: '9300000005', mpin: '5555', gstNumber: '33EEEEE4444E1Z5', name: 'Shop E' });
  await makeShop('F', { phone: '9300000006', mpin: '6666', gstNumber: '19FFFFF5555F1Z5', name: 'Shop F' });
  await makeShop('G', { phone: '9300000007', mpin: '7777', gstNumber: '09GGGGG6666G1Z5', name: 'Shop G' });
  await makeShop('H', { phone: '9300000008', mpin: '8888', gstNumber: '06HHHHH7777H1Z5', name: 'Shop H' });
  await makeShop('I', { phone: '9300000009', mpin: '9999', gstNumber: '23IIIII8888I1Z5', name: 'Shop I' });

  // A second owner of shop A, signing in with a number of their own.
  const secondOwner = await BusinessUser.create({
    businessId: shops.A.id,
    phone: '9300000011',
    fullName: 'Second Owner',
    gstNumber: '27AAAAA0000A1Z5',
    businessName: 'Shop A',
    mpinHash: await bcrypt.hash('1212', 10),
    passwordHash: await bcrypt.hash('1212', 10),
    role: 'OWNER',
  });
  shops.A.secondOwnerId = secondOwner._id;

  // A SUPER account.
  await BusinessUser.create({
    businessId: new mongoose.Types.ObjectId(),
    phone: SUPER_PHONE,
    passwordHash: await bcrypt.hash('super', 10),
    role: 'SUPER',
  });

  // Shop B's work, which moving its owner must leave exactly as it is.
  const db = mongoose.connection.db;
  await db.collection('invoices').insertOne({ businessId: shops.B.id, invoiceNumber: 'B-0001', grandTotal: 125000 });
  await db.collection('scan_billing').insertOne({ businessId: shops.B.id, scanId: 'scan-b-1', credits: 1 });
  await db.collection('organization_wallets').insertOne({ businessId: shops.B.id, balanceCredits: 940 });
  await db.collection('credit_transactions').insertOne({ businessId: shops.B.id, credits: 1000, type: 'PURCHASE' });
  await db.collection('organization_subscriptions').insertOne({ businessId: shops.B.id, plan: 'PRO', status: 'ACTIVE' });

  // Shop E's employee from before sign-in records, on shop D's owner's number.
  created.legacyE = await Employee.create({ businessId: shops.E.id, name: 'Legacy Karigar', phone: '09300000004' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', require('../src/routes/auth.routes'));
  app.use('/api/v1/employees', require('../src/routes/employee.routes'));
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  // Shop A's own employee, shop C's and shop G's: added and signing in as the app does it.
  created.ownA = await addEmployee(shops.A, '9300000021', '2121', 'Own Staff');
  created.staffC = await addEmployee(shops.C, '9300000031', '3131', 'C Staff');
  created.staffG = await addEmployee(shops.G, '9300000071', '7171', 'G Staff');
});

test.after(async () => {
  console.info = realInfo;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('the owner\'s own number is refused on check-phone, the OTP and the add; nothing is texted or written', async () => {
  for (const phone of ['9300000001', '+91 93000 00001']) {
    assert.deepEqual((await check(shops.A, phone)).body, {
      success: true,
      data: { available: false, reason: 'OWN_NUMBER' },
    }, phone);
  }

  const texts = msg91.sent.length;
  const otp = await sendCode(shops.A, '9300000001');
  assert.equal(otp.status, 409);
  assert.deepEqual(otp.body, OWN_NUMBER);
  assert.equal(msg91.sent.length, texts, 'no SMS');

  const before = await counts();
  const add = await api('POST', '/employees', {
    token: ownerToken(shops.A),
    body: newEmployee('9300000001', verified(shops.A, '9300000001')),
  });
  assert.equal(add.status, 409);
  assert.deepEqual(add.body, OWN_NUMBER);
  assert.deepEqual(await counts(), before, 'nothing written, nothing released');

  // The second owner's own number is theirs too.
  const asSecond = await api('GET', '/employees/check-phone?phone=9300000011', {
    token: ownerToken(shops.A, shops.A.secondOwnerId),
  });
  assert.deepEqual(asSecond.body.data, { available: false, reason: 'OWN_NUMBER' });
});

test('a SUPER account and this shop\'s own employee are refused as before', async () => {
  for (const phone of [SUPER_PHONE, '9300000021']) {
    assert.deepEqual((await check(shops.A, phone)).body, { success: true, data: { available: false } }, phone);

    const texts = msg91.sent.length;
    const otp = await sendCode(shops.A, phone);
    assert.equal(otp.status, 409, phone);
    assert.deepEqual(otp.body, PHONE_TAKEN, phone);
    assert.equal(msg91.sent.length, texts, `${phone}: no SMS`);

    const before = await counts();
    const add = await api('POST', '/employees', {
      token: ownerToken(shops.A),
      body: newEmployee(phone, verified(shops.A, phone)),
    });
    assert.equal(add.status, 409, phone);
    assert.deepEqual(add.body, PHONE_TAKEN, phone);
    assert.deepEqual(await counts(), before, `${phone}: nothing written`);
  }
  assert.ok(await BusinessUser.exists({ phone: SUPER_PHONE, role: 'SUPER' }));
  assert.equal((await Employee.findById(created.ownA._id).lean()).isActive, true);
});

test('a shop that may not add another employee is told so before a transfer is even offered', async () => {
  // Shop E has one employee; without a licence it may not add a second.
  await OrganizationLicense.updateOne({ businessId: shops.E.id }, { licenseStatus: 'NO_LICENSE' });
  try {
    const texts = msg91.sent.length;
    const refused = await sendCode(shops.E, '9300000002');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'TRIAL_REQUIRED_FOR_MORE_EMPLOYEES');
    assert.equal(msg91.sent.length, texts);
  } finally {
    await OrganizationLicense.updateOne({ businessId: shops.E.id }, { licenseStatus: 'PERMANENT_LICENSE' });
  }
});

test('another shop\'s owner: check-phone and the OTP say so, and the proved add moves their login aside and makes them an employee here', async () => {
  const phone = '9300000002';
  const shopB = shops.B;
  const original = await rawLogin({ _id: shopB.ownerId });
  assert.ok(original.mpinVault && original.mpinHash && original.passwordHash, 'the record as stored, sealed MPIN included');
  const ownerSession = authService.generateTokens(String(shopB.id), String(shopB.ownerId), 'OWNER');
  const shopBBefore = await shopData(shopB.id);
  assert.ok(shopBBefore.invoices && shopBBefore.organization_wallets && shopBBefore.organization_licenses);

  assert.deepEqual((await check(shops.A, phone)).body, {
    success: true,
    data: { available: true, transfer: { kind: 'owner', sameShop: false } },
  });

  const texts = msg91.sent.length;
  const proof = await proveNumber(shops.A, '+91 93000 00002');
  assert.deepEqual(proof.sent, {
    success: true,
    data: {
      phone,
      expiresInSeconds: 600,
      resendAfterSeconds: 30,
      transfer: { kind: 'owner', sameShop: false },
    },
  });
  assert.equal(msg91.sent.length, texts + 1, 'one SMS, to the number');
  assert.ok(await BusinessUser.exists({ _id: shopB.ownerId }), 'asking and proving move nothing');

  transferLog.length = 0;
  const add = await api('POST', '/employees', {
    token: ownerToken(shops.A),
    body: newEmployee(phone, proof.token, { name: 'B Owner Now Staff' }),
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  created.fromOwnerB = add.body.data.employee;
  assert.equal(created.fromOwnerB.phone, phone);

  // Their owner login is gone from business_users; the number is shop A's employee's.
  assert.equal(await BusinessUser.exists({ _id: shopB.ownerId }), null);
  const account = await BusinessUser.findOne({ phone }).lean();
  assert.equal(account.role, 'EMP');
  assert.equal(String(account.businessId), String(shops.A.id));
  assert.equal(String(account.employeeId), created.fromOwnerB._id);

  // Archived whole, and nothing else of shop B's touched.
  const entries = await ReleasedLogin.find({ phone }).lean();
  assert.equal(entries.length, 1);
  const [entry] = entries;
  created.releasedOwnerB = entry;
  assert.equal(entry.kind, 'owner');
  assert.equal(entry.reason, 'MADE_EMPLOYEE');
  assert.equal(String(entry.fromBusinessId), String(shopB.id));
  assert.equal(String(entry.releasedByBusinessId), String(shops.A.id));
  assert.equal(entry.releasedByUserId, String(shops.A.ownerId));
  assert.ok(entry.releasedAt instanceof Date);
  assert.equal(entry.restoredAt, null);
  assert.equal(entry.employeeId, null);
  assert.deepEqual(plain(entry.original), plain(original));
  assert.equal(entry.original.mpinVault, original.mpinVault);
  assert.deepEqual(await shopData(shopB.id), shopBBefore, 'business, invoices, scans, wallet, credits, licence: as they were');

  // One log line, ids only.
  assert.equal(transferLog.length, 1);
  const [tag, fields] = transferLog[0];
  assert.equal(tag, '[EMPLOYEE_TRANSFER]');
  assert.deepEqual(fields, {
    kind: 'owner',
    toBusinessId: String(shops.A.id),
    fromBusinessId: String(shopB.id),
    releasedLoginId: String(shopB.ownerId),
    employeeId: null,
    releasedId: String(entry._id),
  });
  const logged = JSON.stringify(transferLog);
  for (const secret of [proof.token, proof.otp, original.mpinHash, original.mpinVault, original.passwordHash]) {
    assert.equal(logged.includes(secret), false, 'no codes, hashes or tokens in the log');
  }

  // Their owner session ends at its next refresh; the number now signs in as shop A's employee.
  assert.equal((await refresh(ownerSession.refreshToken)).status, 401);
  assert.equal((await login(phone, '2222')).status, 401, 'the old owner MPIN no longer signs in');
  const asEmployee = await login(phone, '2580');
  assert.equal(asEmployee.status, 200, JSON.stringify(asEmployee.body));
  assert.equal(asEmployee.body.data.role, 'EMP');
  assert.equal(asEmployee.body.data.businessId, String(shops.A.id));
  assert.equal(asEmployee.body.data.userId, created.fromOwnerB._id);
  assert.equal(asEmployee.body.data.businessName, 'Shop A');
});

test('a second owner of this shop: sameShop is true, and they become an employee here', async () => {
  const phone = '9300000011';
  const original = await rawLogin({ _id: shops.A.secondOwnerId });

  assert.deepEqual((await check(shops.A, phone)).body.data, {
    available: true,
    transfer: { kind: 'owner', sameShop: true },
  });
  const proof = await proveNumber(shops.A, phone);
  assert.deepEqual(proof.sent.data.transfer, { kind: 'owner', sameShop: true });

  const add = await api('POST', '/employees', {
    token: ownerToken(shops.A),
    body: newEmployee(phone, proof.token, { name: 'Was Second Owner', mpin: '6060', confirmMpin: '6060' }),
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));

  assert.equal(await BusinessUser.exists({ _id: shops.A.secondOwnerId }), null);
  assert.ok(await BusinessUser.exists({ _id: shops.A.ownerId, role: 'OWNER' }), 'the owner adding them is untouched');
  assert.ok(await Business.exists({ _id: shops.A.id }));
  const entry = await ReleasedLogin.findOne({ phone }).lean();
  assert.equal(entry.kind, 'owner');
  assert.equal(String(entry.fromBusinessId), String(shops.A.id));
  assert.deepEqual(plain(entry.original), plain(original));

  const session = await login(phone, '6060');
  assert.equal(session.status, 200);
  assert.equal(session.body.data.role, 'EMP');
  assert.equal(session.body.data.businessId, String(shops.A.id));
  assert.equal((await login(phone, '1212')).status, 401);
});

test('another shop\'s employee: switched off there, their sign-in archived, and added here', async () => {
  const phone = '9300000031';
  const staffC = created.staffC;
  const session = await login(phone, '3131');
  assert.equal(session.status, 200);
  const original = await rawLogin({ employeeId: new mongoose.Types.ObjectId(staffC._id) });
  assert.equal(original.phone, phone);

  assert.deepEqual((await check(shops.A, phone)).body.data, {
    available: true,
    transfer: { kind: 'employee', sameShop: false },
  });
  const proof = await proveNumber(shops.A, phone);
  assert.deepEqual(proof.sent.data.transfer, { kind: 'employee', sameShop: false });

  transferLog.length = 0;
  const add = await api('POST', '/employees', {
    token: ownerToken(shops.A),
    body: newEmployee(phone, proof.token, { name: 'From Shop C', mpin: '4141', confirmMpin: '4141' }),
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  created.fromStaffC = add.body.data.employee;

  // Still on shop C's roster, switched off; their sign-in record archived.
  const old = await Employee.findById(staffC._id).lean();
  assert.equal(old.isActive, false);
  assert.equal(old.name, 'C Staff');
  assert.equal(String(old.businessId), String(shops.C.id));
  assert.equal(await BusinessUser.exists({ _id: original._id }), null);
  const entry = await ReleasedLogin.findOne({ phone }).lean();
  created.releasedStaffC = entry;
  assert.equal(entry.kind, 'employee');
  assert.equal(String(entry.employeeId), staffC._id);
  assert.equal(String(entry.fromBusinessId), String(shops.C.id));
  assert.equal(entry.previousIsActive, true);
  assert.deepEqual(plain(entry.original), plain(original));
  assert.equal(transferLog.length, 1);
  assert.equal(transferLog[0][1].kind, 'employee');
  assert.equal(transferLog[0][1].employeeId, staffC._id);

  const roster = await api('GET', '/employees', { token: ownerToken(shops.C) });
  assert.deepEqual(roster.body.data.map((e) => [e._id, e.isActive]), [[staffC._id, false]]);
  assert.ok(await BusinessUser.exists({ _id: shops.C.ownerId }), 'shop C\'s owner is untouched');

  // Their shop C session ends; the number signs in to shop A now.
  assert.equal((await refresh(session.body.data.refreshToken)).status, 401);
  const now = await login(phone, '4141');
  assert.equal(now.status, 200);
  assert.equal(now.body.data.businessId, String(shops.A.id));
  assert.equal(now.body.data.userId, created.fromStaffC._id);
});

test('a number that is both another shop\'s owner and another shop\'s employee: the owner is what is said, and both are moved', async () => {
  const phone = '9300000004';
  const original = await rawLogin({ _id: shops.D.ownerId });

  assert.deepEqual((await check(shops.A, phone)).body.data, {
    available: true,
    transfer: { kind: 'owner', sameShop: false },
  });

  transferLog.length = 0;
  const add = await api('POST', '/employees', {
    token: ownerToken(shops.A),
    body: newEmployee(phone, verified(shops.A, phone), { name: 'Both Ways' }),
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));

  assert.equal(await BusinessUser.exists({ _id: shops.D.ownerId }), null);
  assert.equal((await Employee.findById(created.legacyE._id).lean()).isActive, false);
  const entries = await ReleasedLogin.find({ phone }).sort({ createdAt: 1, _id: 1 }).lean();
  assert.deepEqual(entries.map((entry) => entry.kind), ['owner', 'employee']);
  assert.deepEqual(plain(entries[0].original), plain(original));
  assert.equal(entries[1].original, null, 'the old employee had no sign-in record');
  assert.equal(String(entries[1].employeeId), String(created.legacyE._id));
  assert.equal(String(entries[1].fromBusinessId), String(shops.E.id));
  assert.equal(entries[1].previousIsActive, true);
  assert.equal(transferLog.length, 2);
});

test('without the proof for this shop and this number nothing is released', async () => {
  const phone = '9300000006';
  const before = await counts();
  for (const [label, proof] of [
    ['no token', undefined],
    ['a token for another number', verified(shops.A, '9300000066')],
    ['a token another shop proved', verified(shops.B, phone)],
    ['garbage', 'not-a-token'],
  ]) {
    const add = await api('POST', '/employees', { token: ownerToken(shops.A), body: newEmployee(phone, proof) });
    assert.equal(add.status, 403, label);
    assert.deepEqual(add.body, NOT_VERIFIED, label);

    const move = await api('PUT', `/employees/${created.ownA._id}`, {
      token: ownerToken(shops.A),
      body: { phone, ...(proof === undefined ? {} : { phoneVerificationToken: proof }) },
    });
    assert.equal(move.status, 403, `${label}: number change`);
  }
  assert.deepEqual(await counts(), before);
  assert.ok(await BusinessUser.exists({ _id: shops.F.ownerId }));

  // The older paths never move anyone: refused as they always were.
  const draft = await api('POST', '/employees', { token: ownerToken(shops.A), body: { name: 'Draft', phone } });
  assert.equal(draft.status, 409);
  assert.deepEqual(draft.body, PHONE_TAKEN);
  assert.deepEqual(await counts(), before);
});

test('an add that fails after the release puts back everything it moved', async () => {
  const realCreate = employeeAccounts.createAccountFor;

  // Any failure: a 500, and shop F's owner is back exactly as they were.
  const ownerF = await rawLogin({ _id: shops.F.ownerId });
  const employeesBefore = await Employee.countDocuments();
  employeeAccounts.createAccountFor = async () => { throw new Error('write failed'); };
  try {
    const add = await api('POST', '/employees', {
      token: ownerToken(shops.A),
      body: newEmployee('9300000006', verified(shops.A, '9300000006')),
    });
    assert.equal(add.status, 500);
  } finally {
    employeeAccounts.createAccountFor = realCreate;
  }
  assert.deepEqual(plain(await rawLogin({ _id: shops.F.ownerId })), plain(ownerF));
  assert.equal(await Employee.countDocuments(), employeesBefore, 'no employee left behind');
  const entryF = await ReleasedLogin.findOne({ phone: '9300000006' }).lean();
  assert.ok(entryF.restoredAt instanceof Date, 'the archive says it went back');
  const ownerLogin = await login('9300000006', '6666');
  assert.equal(ownerLogin.status, 200);
  assert.equal(ownerLogin.body.data.role, 'OWNER');
  assert.equal(ownerLogin.body.data.businessId, String(shops.F.id));

  // Losing the number at the last moment: a 409, and shop G's employee is
  // switched back on with their sign-in record as it was.
  const staffG = await rawLogin({ phone: '9300000071' });
  employeeAccounts.createAccountFor = async () => { throw new Error('PHONE_ALREADY_REGISTERED'); };
  try {
    const add = await api('POST', '/employees', {
      token: ownerToken(shops.A),
      body: newEmployee('9300000071', verified(shops.A, '9300000071')),
    });
    assert.equal(add.status, 409);
    assert.deepEqual(add.body, PHONE_TAKEN);
  } finally {
    employeeAccounts.createAccountFor = realCreate;
  }
  assert.deepEqual(plain(await rawLogin({ phone: '9300000071' })), plain(staffG));
  assert.equal((await Employee.findById(created.staffG._id).lean()).isActive, true);
  const back = await login('9300000071', '7171');
  assert.equal(back.status, 200);
  assert.equal(back.body.data.businessId, String(shops.G.id));
});

test('changing an employee\'s number to another shop\'s owner\'s moves that owner aside the same way, and back if the change fails', async () => {
  const staff = await addEmployee(shops.A, '9300000041', '4242', 'Number Changer');
  const ownerH = await rawLogin({ _id: shops.H.ownerId });

  const proof = await proveNumber(shops.A, '9300000008');
  assert.deepEqual(proof.sent.data.transfer, { kind: 'owner', sameShop: false });
  const moved = await api('PUT', `/employees/${staff._id}`, {
    token: ownerToken(shops.A),
    body: { phone: '9300000008', phoneVerificationToken: proof.token },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.data.phone, '9300000008');
  assert.equal(await BusinessUser.exists({ _id: shops.H.ownerId }), null);
  const entry = await ReleasedLogin.findOne({ phone: '9300000008' }).lean();
  assert.deepEqual(plain(entry.original), plain(ownerH));
  const account = await BusinessUser.findOne({ employeeId: new mongoose.Types.ObjectId(staff._id) }).lean();
  assert.equal(account.phone, '9300000008');
  assert.equal((await login('9300000008', '4242')).body.data.userId, staff._id);
  assert.equal((await login('9300000041', '4242')).status, 401, 'the old number is free');

  // The change failing after the release: shop I's owner and the employee's
  // number both go back.
  const ownerI = await rawLogin({ _id: shops.I.ownerId });
  const realSync = employeeAccounts.syncAccountOf;
  let calls = 0;
  employeeAccounts.syncAccountOf = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('write failed');
    return realSync(...args);
  };
  try {
    const failed = await api('PUT', `/employees/${staff._id}`, {
      token: ownerToken(shops.A),
      body: { phone: '9300000009', name: 'Renamed', phoneVerificationToken: verified(shops.A, '9300000009') },
    });
    assert.equal(failed.status, 500);
  } finally {
    employeeAccounts.syncAccountOf = realSync;
  }
  assert.deepEqual(plain(await rawLogin({ _id: shops.I.ownerId })), plain(ownerI));
  const stored = await Employee.findById(staff._id).lean();
  assert.equal(stored.phone, '9300000008');
  assert.equal(stored.name, 'Number Changer');
  assert.equal((await login('9300000008', '4242')).status, 200);
  assert.equal((await login('9300000009', '9999')).body.data.role, 'OWNER');
});

test('the restore script puts a released login back once the number is free, and never over someone else', async () => {
  const shopB = shops.B;
  const entryB = created.releasedOwnerB;

  // The number is shop A's employee's now: refused, nothing written.
  const before = await counts();
  assert.deepEqual(await restoreReleasedLogin(String(entryB._id)), {
    releasedId: String(entryB._id),
    kind: 'owner',
    loginId: String(shopB.ownerId),
    employeeId: null,
    fromBusinessId: String(shopB.id),
    restored: false,
    reason: 'PHONE_ALREADY_REGISTERED',
  });
  assert.deepEqual(await counts(), before);
  assert.equal((await ReleasedLogin.findById(entryB._id).lean()).restoredAt, null);

  // Freed (the employee deleted), it goes back exactly as it was and signs in as before.
  assert.equal((await api('DELETE', `/employees/${created.fromOwnerB._id}`, { token: ownerToken(shops.A) })).status, 200);
  const restored = await restoreReleasedLogin(String(entryB._id));
  assert.equal(restored.restored, true);
  assert.deepEqual(plain(await rawLogin({ _id: shopB.ownerId })), plain(entryB.original));
  const owner = await login('9300000002', '2222');
  assert.equal(owner.status, 200);
  assert.equal(owner.body.data.role, 'OWNER');
  assert.equal(owner.body.data.businessId, String(shopB.id));
  assert.ok((await ReleasedLogin.findById(entryB._id).lean()).restoredAt instanceof Date);
  assert.equal((await restoreReleasedLogin(String(entryB._id))).reason, 'ALREADY_RESTORED');

  // Another shop's employee: switched back on, with their sign-in record.
  const entryC = created.releasedStaffC;
  assert.equal((await restoreReleasedLogin(String(entryC._id))).reason, 'PHONE_ALREADY_REGISTERED');
  assert.equal((await api('DELETE', `/employees/${created.fromStaffC._id}`, { token: ownerToken(shops.A) })).status, 200);
  assert.equal((await restoreReleasedLogin(String(entryC._id))).restored, true);
  assert.equal((await Employee.findById(created.staffC._id).lean()).isActive, true);
  const staff = await login('9300000031', '3131');
  assert.equal(staff.status, 200);
  assert.equal(staff.body.data.businessId, String(shops.C.id));
  assert.equal(staff.body.data.userId, created.staffC._id);

  // An employee their shop has deleted since is not brought back.
  const [, entryLegacy] = await ReleasedLogin.find({ phone: '9300000004' }).sort({ createdAt: 1, _id: 1 }).lean();
  assert.equal((await api('DELETE', `/employees/${created.legacyE._id}`, { token: ownerToken(shops.E) })).status, 200);
  const gone = await restoreReleasedLogin(String(entryLegacy._id));
  assert.equal(gone.restored, false);
  assert.equal(gone.reason, 'EMPLOYEE_NOT_FOUND');
  assert.equal((await ReleasedLogin.findById(entryLegacy._id).lean()).restoredAt, null);

  await assert.rejects(() => restoreReleasedLogin('not-an-id'), /usage/);
  await assert.rejects(() => restoreReleasedLogin(String(new mongoose.Types.ObjectId())), /No released login/);
});

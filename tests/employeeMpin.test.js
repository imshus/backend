/**
 * Employees as sign-in users.
 *
 * The owner adds an employee in one request — name, phone, designation, the
 * 4-digit MPIN they set on the Employee Credentials screen, and the
 * permissions picked next — and the employee then signs in exactly as the
 * owner does: phone, OTP, MPIN. Underneath, every employee has a record in
 * business_users with role EMP carrying the shop's GST details (copied from
 * the owner's record) and a mirror of the permissions; the Employee document
 * stays the source of truth. A number that is already anyone's — owner or
 * employee, any shop — is refused before anything is written.
 *
 * Runs against a real (in-memory) MongoDB and the real routes, so the unique
 * phone index, the RBAC middleware and the tokens are the ones production
 * uses. No paid API is reached: OTP and GST lookups are stubbed.
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
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Business = require('../src/models/business.model');
const BusinessUser = require('../src/models/businessUser.model');
const Employee = require('../src/models/employee.model');
const OrganizationLicense = require('../src/models/organizationLicense.model');
const authService = require('../src/services/auth.service');
const otpService = require('../src/services/otp.service');
const gstService = require('../src/services/gst.service');
const registrationService = require('../src/services/registration.service');
const profileEditService = require('../src/services/profileEdit.service');
const accountDeletionService = require('../src/services/accountDeletion.service');
const redisClient = require('../src/redis/redisClient');
const { openMpin } = require('../src/utils/mpinVault');
const employeeAccounts = require('../src/services/employeeAccount.service');
const { loginIdentifierOf } = require('../src/middleware/rateLimiter');
const { loginLookupOf } = require('../src/utils/phone');
const { authenticateJWT } = require('../src/middleware/auth.middleware');
const { requirePermission } = require('../src/middleware/rbac.middleware');
const errorHandler = require('../src/middleware/errorHandler');

// Nothing here may text anyone or call the GST registry.
const otpCalls = { sent: [] };
otpService.sendMobileOtp = async (args) => {
  otpCalls.sent.push(args.mobile);
  return { sent: true };
};
otpService.verifyOtpByMobile = async () => ({ verified: true });
gstService.verifyGST = async (gstNumber) => ({
  gstNumber,
  legalName: 'NEW LEGAL NAME PVT LTD',
  tradeName: 'New Trade Name',
  address: '9 New Market Road, Pune 411001',
  businessType: 'Retailer',
  gstStatus: 'Active',
  stateName: 'Maharashtra',
  pincode: '411001',
  isMock: false,
});

let mongoServer;
let server;
let baseUrl;

const shopA = { id: new mongoose.Types.ObjectId() };
const shopB = { id: new mongoose.Types.ObjectId() };
const OWNER_A_PHONE = '9000000001';
const OWNER_B_PHONE = '9000000002';
const OWNER_A_MPIN = '1111';

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

const ownerToken = (shop) =>
  authService.generateTokens(String(shop.id), String(shop.ownerId), 'OWNER').accessToken;

/** Every string anywhere in a value, for "is this plain MPIN stored anywhere?". */
function containsExactString(value, needle) {
  if (typeof value === 'string') return value === needle;
  if (value instanceof Date || value === null || value === undefined) return false;
  if (typeof value === 'object') {
    if (value._bsontype) return String(value) === needle;
    return Object.values(value).some((inner) => containsExactString(inner, needle));
  }
  return String(value) === needle;
}

async function counts() {
  const [employees, users] = await Promise.all([Employee.countDocuments(), BusinessUser.countDocuments()]);
  return { employees, users };
}

test.before(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongoServer.getUri());
  // The unique phone index has to exist: it is what a race is decided on.
  await Promise.all([BusinessUser.init(), Employee.init()]);

  // Shop A: the owner's record carries the business's GST details, as
  // registration copies them. (A shop whose copy fell behind is shop C, below.)
  await Business.create({
    _id: shopA.id,
    gstNumber: '27AAAAA0000A1Z5',
    legalName: 'SHREE JEWELLERS PVT LTD',
    tradeName: 'Shree Jewellers',
    businessType: 'Retailer',
    gstStatus: 'Active',
    address: '12 Zaveri Bazaar, Mumbai 400002',
    isRegistered: true,
  });
  const ownerA = await BusinessUser.create({
    businessId: shopA.id,
    phone: OWNER_A_PHONE,
    fullName: 'Amit Owner',
    gstNumber: '27AAAAA0000A1Z5',
    businessName: 'Shree Jewellers',
    address: '12 Zaveri Bazaar, Mumbai 400002',
    mpinHash: await bcrypt.hash(OWNER_A_MPIN, 10),
    passwordHash: await bcrypt.hash(OWNER_A_MPIN, 10),
    role: 'OWNER',
  });
  shopA.ownerId = ownerA._id;

  await Business.create({
    _id: shopB.id,
    gstNumber: '07BBBBB1111B1Z5',
    legalName: 'OTHER SHOP',
    tradeName: 'Other Shop',
    businessType: 'Retailer',
    gstStatus: 'Active',
    address: 'Karol Bagh, Delhi',
    isRegistered: true,
  });
  const ownerB = await BusinessUser.create({
    businessId: shopB.id,
    phone: OWNER_B_PHONE,
    gstNumber: '07BBBBB1111B1Z5',
    businessName: 'Other Shop',
    address: 'Karol Bagh, Delhi',
    passwordHash: await bcrypt.hash('2222', 10),
    mpinHash: await bcrypt.hash('2222', 10),
    role: 'OWNER',
  });
  shopB.ownerId = ownerB._id;

  // Both shops can hold more than one employee.
  await OrganizationLicense.create([
    { businessId: shopA.id, ownerUserId: ownerA._id, ownerPhone: OWNER_A_PHONE, licenseStatus: 'PERMANENT_LICENSE' },
    { businessId: shopB.id, ownerUserId: ownerB._id, ownerPhone: OWNER_B_PHONE, licenseStatus: 'PERMANENT_LICENSE' },
  ]);

  // An employee of shop B from before sign-in records existed: active, a
  // password, no record in business_users.
  created.legacyB = await Employee.create({
    businessId: shopB.id,
    name: 'Old Karigar',
    phone: '9811100009',
    passwordHash: await bcrypt.hash('oldpass', 10),
  });
  // And an inactive one, whose number is free again.
  await Employee.create({
    businessId: shopB.id,
    name: 'Left Last Year',
    phone: '9811100008',
    passwordHash: await bcrypt.hash('oldpass', 10),
    isActive: false,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', require('../src/routes/auth.routes'));
  app.use('/api/v1/employees', require('../src/routes/employee.routes'));
  app.use('/api/v1/settings', require('../src/routes/settings.routes'));
  // A route guarded the way the rate and settings routes are.
  app.post('/api/v1/probe/formula', authenticateJWT, requirePermission('manageFormulae'), (req, res) => {
    res.json({ success: true, user: req.user });
  });
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

test('adding an employee with an MPIN creates them and their EMP sign-in record, MPIN hashed and sealed, never plain', async () => {
  // A draft an older build left behind is spent by this request.
  await redisClient.set(`emp_draft:${shopA.id}`, JSON.stringify({ name: 'Stale Draft', permissions: { editRateGold: true } }), 'EX', 3600);

  const { status, body } = await api('POST', '/employees', {
    token: ownerToken(shopA),
    body: {
      name: ' Ravi Kumar ',
      phone: '+91 98111 00001',
      email: 'Ravi@Example.com',
      designation: 'Sales',
      mpin: '0451',
      confirmMpin: '0451',
      permissions: { manageFormulae: true, editRateGold: false },
    },
  });

  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.success, true);
  const employee = body.data.employee;
  created.ravi = employee;
  assert.equal(employee.name, 'Ravi Kumar');
  assert.equal(employee.phone, '9811100001', 'the number is stored as its ten digits');
  assert.equal(employee.designation, 'Sales');
  assert.deepEqual(employee.permissions, { manageFormulae: true, editRateGold: false });
  assert.equal(employee.hasMpin, true);
  for (const secret of ['passwordHash', 'mpinHash', 'mpinVault']) {
    assert.equal(secret in employee, false, `${secret} never leaves the server`);
  }
  assert.equal(await redisClient.get(`emp_draft:${shopA.id}`), null, 'the leftover draft is cleared');

  const stored = await Employee.findById(employee._id).lean();
  assert.equal(stored.passwordHash, undefined, 'no password on an MPIN employee');
  assert.equal(stored.isActive, true);

  const account = await BusinessUser.findOne({ employeeId: employee._id }).select('+mpinVault').lean();
  assert.ok(account, 'an EMP user is created');
  assert.equal(String(stored.businessUserId), String(account._id), 'the employee links to it');
  assert.equal(account.role, 'EMP');
  assert.equal(String(account.businessId), String(shopA.id));
  assert.equal(account.phone, '9811100001');
  assert.equal(account.fullName, 'Ravi Kumar');
  assert.equal(account.passwordHash, undefined);
  assert.deepEqual(account.permissions, { manageFormulae: true, editRateGold: false }, 'permissions mirrored');

  // The shop's GST details, exactly as the owner's record carries them.
  assert.equal(account.gstNumber, '27AAAAA0000A1Z5');
  assert.equal(account.businessName, 'Shree Jewellers');
  assert.equal(account.address, '12 Zaveri Bazaar, Mumbai 400002');

  assert.notEqual(account.mpinHash, '0451');
  assert.equal(await bcrypt.compare('0451', account.mpinHash), true, 'hashed with bcrypt');
  assert.notEqual(account.mpinVault, '0451');
  assert.equal(openMpin(account.mpinVault), '0451', 'sealed so the owner can read it back');

  // Nowhere in either collection does the plain MPIN appear.
  const rawUsers = await mongoose.connection.db.collection('business_users').find({}).toArray();
  const rawEmployees = await mongoose.connection.db.collection('employees').find({}).toArray();
  assert.equal(containsExactString(rawUsers, '0451'), false);
  assert.equal(containsExactString(rawEmployees, '0451'), false);
});

test('a number that is anyone\'s is refused with 409 and nothing is written', async () => {
  const token = ownerToken(shopA);
  const base = { name: 'Dup', designation: 'Sales', mpin: '1234', confirmMpin: '1234' };
  const cases = [
    ['the owner\'s own number', OWNER_A_PHONE],
    ['another shop\'s owner', OWNER_B_PHONE],
    ['an employee of this shop', '98111 00001'],
    ['an active employee of another shop with no sign-in record', '9811100009'],
  ];

  for (const [label, phone] of cases) {
    const before = await counts();
    const { status, body } = await api('POST', '/employees', { token, body: { ...base, phone } });
    assert.equal(status, 409, label);
    assert.deepEqual(body, {
      success: false,
      error: 'PHONE_ALREADY_REGISTERED',
      message: 'This number is already registered',
    }, label);
    assert.deepEqual(await counts(), before, `${label}: nothing written`);
  }

  // The same number from another shop's owner: refused, without saying whose.
  const fromB = await api('POST', '/employees', {
    token: ownerToken(shopB),
    body: { ...base, phone: '9811100001' },
  });
  assert.equal(fromB.status, 409);
  assert.equal(JSON.stringify(fromB.body).includes('Shree'), false);
});

test('check-phone answers available or not, for the owner only', async () => {
  const token = ownerToken(shopA);
  const check = (phone, as = token) => api('GET', `/employees/check-phone?phone=${encodeURIComponent(phone)}`, { token: as });

  assert.deepEqual((await check('9822200001')).body, { success: true, data: { available: true } });
  assert.equal((await check('+91 98222 00001')).body.data.available, true, 'formatted numbers are read as ten digits');
  for (const taken of [OWNER_A_PHONE, OWNER_B_PHONE, '9811100001', '9811100009']) {
    assert.equal((await check(taken)).body.data.available, false, taken);
  }
  assert.equal((await check('9811100008')).body.data.available, true, 'an inactive employee no longer holds a number');

  const bad = await check('12345');
  assert.equal(bad.status, 400);

  const login = await registrationService.login('9811100001', { mpin: '0451' });
  const asEmployee = await check('9822200001', login.accessToken);
  assert.equal(asEmployee.status, 403, 'an employee cannot probe numbers');
});

test('the employee signs in through the owner login with phone + MPIN and gets an EMP session', async () => {
  const { status, body } = await api('POST', '/auth/login', { body: { mobile: '9811100001', mpin: '0451' } });
  assert.equal(status, 200, JSON.stringify(body));
  const data = body.data;
  assert.equal(data.role, 'EMP');
  assert.equal(data.userId, created.ravi._id, 'the Employee document\'s id, which RBAC reads');
  assert.equal(data.businessId, String(shopA.id));
  assert.equal(data.fullName, 'Ravi Kumar');
  assert.equal(data.phone, '9811100001');
  assert.equal(data.businessName, 'Shree Jewellers');
  assert.equal(data.gstNumber, '27AAAAA0000A1Z5');
  assert.equal(data.address, '12 Zaveri Bazaar, Mumbai 400002');
  assert.deepEqual(data.permissions, { manageFormulae: true, editRateGold: false });

  const claims = jwt.decode(data.accessToken);
  assert.equal(claims.role, 'EMP');
  assert.equal(claims.userId, created.ravi._id);
  assert.equal(claims.businessId, String(shopA.id));
  assert.deepEqual(claims.permissions, { manageFormulae: true, editRateGold: false });

  // RBAC loads the employee's permissions from that id.
  const allowed = await api('POST', '/probe/formula', { token: data.accessToken });
  assert.equal(allowed.status, 200);

  // The owner takes the permission away: refused at once with the same token,
  // mirrored on the sign-in record, and gone from the next refreshed token.
  const edit = await api('PUT', `/employees/${created.ravi._id}`, {
    token: ownerToken(shopA),
    body: { permissions: { manageFormulae: false, editRateGold: true } },
  });
  assert.equal(edit.status, 200);
  const denied = await api('POST', '/probe/formula', { token: data.accessToken });
  assert.equal(denied.status, 403);
  const account = await BusinessUser.findOne({ employeeId: created.ravi._id }).lean();
  assert.deepEqual(account.permissions, { manageFormulae: false, editRateGold: true });
  const refreshed = await api('POST', '/auth/refresh', { body: { refreshToken: data.refreshToken } });
  assert.equal(refreshed.status, 200);
  assert.deepEqual(jwt.decode(refreshed.body.data.accessToken).permissions, { manageFormulae: false, editRateGold: true });

  // An EMP token is still an employee's: owner-only routes refuse it.
  const addAsEmployee = await api('POST', '/employees', {
    token: data.accessToken,
    body: { name: 'X', phone: '9822200002', designation: 'S', mpin: '1234', confirmMpin: '1234' },
  });
  assert.equal(addAsEmployee.status, 403);

  // Their profile shows their own number and name.
  const profile = await api('GET', '/settings/business-profile', { token: data.accessToken });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.phone, '9811100001');
  assert.equal(profile.body.data.fullName, 'Ravi Kumar');
});

test('a wrong MPIN is a 401, and the owner\'s own login is untouched', async () => {
  const wrong = await api('POST', '/auth/login', { body: { mobile: '9811100001', mpin: '9999' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'INVALID_PHONE_CREDENTIALS');

  const owner = await api('POST', '/auth/login', { body: { mobile: OWNER_A_PHONE, mpin: OWNER_A_MPIN } });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.data.role, 'OWNER');
  assert.equal(owner.body.data.userId, String(shopA.ownerId));
  assert.equal(owner.body.data.permissions, undefined);
});

test('an inactive employee is refused, and comes back when switched on', async () => {
  const token = ownerToken(shopA);
  const off = await api('PUT', `/employees/${created.ravi._id}`, { token, body: { isActive: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.isActive, false);
  const account = await BusinessUser.findOne({ employeeId: created.ravi._id }).lean();
  assert.equal(account.isActive, false, 'the sign-in record follows');

  const refused = await api('POST', '/auth/login', { body: { mobile: '9811100001', mpin: '0451' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'EMPLOYEE_INACTIVE');
  const wrong = await api('POST', '/auth/login', { body: { mobile: '9811100001', mpin: '0000' } });
  assert.equal(wrong.status, 401, 'without the MPIN nothing about the account is said');

  await api('PUT', `/employees/${created.ravi._id}`, { token, body: { isActive: true } });
  const back = await api('POST', '/auth/login', { body: { mobile: '9811100001', mpin: '0451' } });
  assert.equal(back.status, 200);
});

test('switching an employee back on re-checks their number: one taken meanwhile is a 409 and nothing is written', async () => {
  // Shop B's employee who left before sign-in records existed: off, a
  // password, no record in business_users — so their number is free...
  const left = await Employee.findOne({ businessId: shopB.id, phone: '9811100008' });
  assert.equal(left.isActive, false);
  assert.equal(await BusinessUser.exists({ employeeId: left._id }), null);

  // ...and shop A is given it.
  const taken = await api('POST', '/employees', {
    token: ownerToken(shopA),
    body: { name: 'New Hire', phone: '9811100008', designation: 'Sales', mpin: '8080', confirmMpin: '8080' },
  });
  assert.equal(taken.status, 201, JSON.stringify(taken.body));
  created.newHire = taken.body.data.employee;

  // Shop B's owner switches the old employee back on, with or without other edits.
  for (const body of [{ isActive: true }, { isActive: true, name: 'Back Again', permissions: { manageFormulae: true } }]) {
    const before = await counts();
    const refused = await api('PUT', `/employees/${left._id}`, { token: ownerToken(shopB), body });
    assert.equal(refused.status, 409, JSON.stringify(body));
    assert.deepEqual(refused.body, {
      success: false,
      error: 'PHONE_ALREADY_REGISTERED',
      message: 'This number is already registered',
    });
    assert.deepEqual(await counts(), before, 'nothing written');
    const stored = await Employee.findById(left._id).lean();
    assert.equal(stored.isActive, false, 'still off');
    assert.equal(stored.name, 'Left Last Year');
    assert.deepEqual(stored.permissions, {});
  }
  assert.equal(await BusinessUser.exists({ employeeId: left._id }), null);

  // Edits that leave them off are not a claim on the number.
  const rename = await api('PUT', `/employees/${left._id}`, { token: ownerToken(shopB), body: { name: 'Left Last Year (old)' } });
  assert.equal(rename.status, 200);

  // A race lost after the check (the number taken between check and write):
  // everything the request changed is put back, and the answer is the same 409.
  const realCheck = employeeAccounts.isPhoneRegistered;
  employeeAccounts.isPhoneRegistered = async () => false;
  try {
    const raced = await api('PUT', `/employees/${left._id}`, {
      token: ownerToken(shopB),
      body: { isActive: true, name: 'Raced', designation: 'Karigar' },
    });
    assert.equal(raced.status, 409);
    assert.equal(raced.body.error, 'PHONE_ALREADY_REGISTERED');
  } finally {
    employeeAccounts.isPhoneRegistered = realCheck;
  }
  const afterRace = await Employee.findById(left._id).lean();
  assert.equal(afterRace.isActive, false);
  assert.equal(afterRace.name, 'Left Last Year (old)');
  assert.equal(afterRace.designation, '');
  assert.equal(await BusinessUser.exists({ employeeId: left._id }), null);

  // A number nobody took meanwhile: back on, with a sign-in record.
  const free = await Employee.create({
    businessId: shopB.id,
    name: 'Seasonal',
    phone: '9811100007',
    passwordHash: await bcrypt.hash('oldpass', 10),
    isActive: false,
  });
  const on = await api('PUT', `/employees/${free._id}`, { token: ownerToken(shopB), body: { isActive: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.data.isActive, true);
  const account = await BusinessUser.findOne({ employeeId: free._id }).lean();
  assert.equal(account.phone, '9811100007');
  assert.equal(account.isActive, true);
  assert.equal(account.gstNumber, '07BBBBB1111B1Z5');
});

test('the older two-step add still works, refuses taken numbers, and gives the same session', async () => {
  const token = ownerToken(shopA);

  // Step one with a taken number: refused, no draft kept.
  const takenDraft = await api('POST', '/employees', { token, body: { name: 'Nope', phone: OWNER_B_PHONE } });
  assert.equal(takenDraft.status, 409);
  assert.equal(await redisClient.get(`emp_draft:${shopA.id}`), null);

  // A finish whose (older) draft holds a taken number: refused, nothing written.
  await redisClient.set(`emp_draft:${shopA.id}`, JSON.stringify({ name: 'Old Draft', phone: OWNER_B_PHONE }), 'EX', 3600);
  const before = await counts();
  const takenFinish = await api('POST', '/employees', { token, body: { password: 'secret12' } });
  assert.equal(takenFinish.status, 409);
  assert.deepEqual(await counts(), before);

  const draft = await api('POST', '/employees', {
    token,
    body: {
      name: 'Draft Name',
      phone: '9811100002',
      email: 'sita@pratham.gmail.com',
      designation: '',
      permissions: { manageFormulae: true },
    },
  });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.message, 'Draft saved successfully');

  // What the finishing request sends wins over the draft.
  const finish = await api('POST', '/employees', { token, body: { password: 'secret12', name: 'Sita Devi' } });
  assert.equal(finish.status, 201, JSON.stringify(finish.body));
  assert.equal(finish.body.data.name, 'Sita Devi');
  assert.equal(finish.body.data.employee.hasMpin, false);
  assert.equal(await redisClient.get(`emp_draft:${shopA.id}`), null);
  created.sita = finish.body.data.employee;

  const stored = await Employee.findById(created.sita._id).lean();
  assert.equal(await bcrypt.compare('secret12', stored.passwordHash), true);
  const account = await BusinessUser.findOne({ employeeId: created.sita._id }).lean();
  assert.ok(account, 'an EMP user exists for the legacy path too');
  assert.equal(account.mpinHash, undefined);
  assert.equal(account.businessName, 'Shree Jewellers');

  // The old login still signs them in...
  const legacy = await api('POST', '/auth/employee/login', { body: { phone: '9811100002', password: 'secret12' } });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal(legacy.body.data.role, 'EMP');
  assert.equal(legacy.body.data.userId, created.sita._id);
  assert.deepEqual(legacy.body.data.permissions, { manageFormulae: true });

  // ...but the phone + MPIN login has no MPIN to check yet, and says whose job that is.
  const noMpin = await api('POST', '/auth/login', { body: { mobile: '9811100002', mpin: '1234' } });
  assert.equal(noMpin.status, 409);
  assert.equal(noMpin.body.error, 'EMPLOYEE_MPIN_NOT_SET');
  assert.equal(noMpin.body.message, 'Ask your shop owner to set your MPIN');

  // The owner sets it; it reads back; both logins now issue equivalent tokens.
  assert.deepEqual((await api('GET', `/employees/${created.sita._id}/mpin`, { token })).body, { success: true, data: { mpin: null } });
  const set = await api('PUT', `/employees/${created.sita._id}/mpin`, { token, body: { mpin: '7788', confirmMpin: '7788' } });
  assert.deepEqual(set, { status: 200, body: { success: true } });
  const read = await api('GET', `/employees/${created.sita._id}/mpin`, { token });
  assert.deepEqual(read.body, { success: true, data: { mpin: '7788' } });

  const viaMpin = await api('POST', '/auth/login', { body: { mobile: '9811100002', mpin: '7788' } });
  assert.equal(viaMpin.status, 200);
  const relogin = await api('POST', '/auth/employee/login', { body: { phone: '9811100002', password: 'secret12' } });
  const strip = ({ iat, exp, ...rest }) => rest;
  assert.deepEqual(strip(jwt.decode(viaMpin.body.data.accessToken)), strip(jwt.decode(relogin.body.data.accessToken)));
  const legacyKeys = Object.keys(relogin.body.data).sort();
  assert.deepEqual(Object.keys(viaMpin.body.data).sort(), legacyKeys, 'the same response shape');
});

test('PUT and GET /:id/mpin: owner of that shop only', async () => {
  const id = created.ravi._id;
  const employeeLogin = await registrationService.login('9811100001', { mpin: '0451' });

  const fromOtherShop = await api('GET', `/employees/${id}/mpin`, { token: ownerToken(shopB) });
  assert.equal(fromOtherShop.status, 404);
  const setFromOtherShop = await api('PUT', `/employees/${id}/mpin`, {
    token: ownerToken(shopB), body: { mpin: '5555', confirmMpin: '5555' },
  });
  assert.equal(setFromOtherShop.status, 404);

  assert.equal((await api('GET', `/employees/${id}/mpin`, { token: employeeLogin.accessToken })).status, 403);
  assert.equal((await api('PUT', `/employees/${id}/mpin`, {
    token: employeeLogin.accessToken, body: { mpin: '5555', confirmMpin: '5555' },
  })).status, 403);

  assert.equal((await api('GET', '/employees/not-an-id/mpin', { token: ownerToken(shopA) })).status, 404);
  const mismatch = await api('PUT', `/employees/${id}/mpin`, {
    token: ownerToken(shopA), body: { mpin: '5555', confirmMpin: '5556' },
  });
  assert.equal(mismatch.status, 400);

  // Still the MPIN it was: nothing above changed it.
  assert.equal((await api('GET', `/employees/${id}/mpin`, { token: ownerToken(shopA) })).body.data.mpin, '0451');

  // Changing it: the old MPIN stops working, the new one signs in.
  const change = await api('PUT', `/employees/${id}/mpin`, { token: ownerToken(shopA), body: { mpin: '2468', confirmMpin: '2468' } });
  assert.equal(change.status, 200);
  assert.equal((await api('POST', '/auth/login', { body: { mobile: '9811100001', mpin: '0451' } })).status, 401);
  assert.equal((await api('POST', '/auth/login', { body: { mobile: '9811100001', mpin: '2468' } })).status, 200);
});

test('an employee from before sign-in records gets one when the owner sets their MPIN', async () => {
  const legacy = await Employee.create({
    businessId: shopA.id,
    name: 'Before Records',
    phone: '9811100003',
    passwordHash: await bcrypt.hash('pw', 10),
  });
  assert.equal(await BusinessUser.exists({ employeeId: legacy._id }), null);

  const set = await api('PUT', `/employees/${legacy._id}/mpin`, { token: ownerToken(shopA), body: { mpin: '3030', confirmMpin: '3030' } });
  assert.equal(set.status, 200);
  const account = await BusinessUser.findOne({ employeeId: legacy._id }).lean();
  assert.equal(account.role, 'EMP');
  assert.equal(account.gstNumber, '27AAAAA0000A1Z5');
  assert.equal((await api('POST', '/auth/login', { body: { mobile: '9811100003', mpin: '3030' } })).body.data.role, 'EMP');
});

test('check-availability reports employees\' numbers so sign-up refuses them and login goes on to the MPIN', async () => {
  const taken = await api('POST', '/auth/check-availability', { body: { mobile: '9811100001' } });
  assert.deepEqual(taken.body.data, { phoneTaken: true, userIdTaken: false, phoneHasMpin: true });

  // No MPIN yet: still never sent to create one of their own.
  const noMpinYet = await Employee.create({ businessId: shopA.id, name: 'No Mpin', phone: '9811100004', designation: 'Sales' });
  await require('../src/services/employeeAccount.service').createAccountFor(noMpinYet);
  const pending = await api('POST', '/auth/check-availability', { body: { mobile: '9811100004' } });
  assert.equal(pending.body.data.phoneTaken, true);
  assert.equal(pending.body.data.phoneHasMpin, true);

  const free = await api('POST', '/auth/check-availability', { body: { mobile: '9822200009' } });
  assert.equal(free.body.data.phoneTaken, false);

  const shell = await Business.create({
    gstNumber: '29CCCCC2222C1Z5', legalName: 'New', tradeName: 'New', businessType: 'Retailer',
    gstStatus: 'Active', address: 'x',
  });
  await assert.rejects(
    registrationService.submitContactDetails(String(shell._id), '9811100001'),
    /PHONE_ALREADY_EXISTS/,
    'a new shop cannot sign up on an employee\'s number',
  );
});

test('owner recovery flows refuse an employee\'s number, before any code is sent', async () => {
  otpCalls.sent.length = 0;
  const forgot = await api('POST', '/auth/forgot-password/request', { body: { identifier: '9811100001' } });
  assert.equal(forgot.status, 403);
  assert.equal(forgot.body.error, 'EMPLOYEE_MPIN_MANAGED_BY_OWNER');
  assert.equal(otpCalls.sent.length, 0);

  const verify = await api('POST', '/auth/forgot-password/verify-otp', { body: { identifier: '9811100001', otp: '123456' } });
  assert.equal(verify.status, 403);

  // An OTP alone never admits an employee: their number was typed, not proved.
  const viaOtp = await api('POST', '/auth/login-otp', { body: { mobile: '9811100001', otp: '123456' } });
  assert.equal(viaOtp.status, 403);
  assert.equal(viaOtp.body.error, 'EMPLOYEE_MPIN_REQUIRED');
});

test('an MPIN-only employee has no password: the old login and change-password are 401s, not 500s', async () => {
  const oldLogin = await api('POST', '/auth/employee/login', { body: { phone: '9811100001', password: 'anything' } });
  assert.equal(oldLogin.status, 401);
  assert.equal(oldLogin.body.error, 'INVALID_EMPLOYEE_CREDENTIALS');

  const session = await registrationService.login('9811100001', { mpin: '2468' });
  const change = await api('POST', '/auth/change-password', {
    token: session.accessToken,
    body: { currentPassword: 'whatever', newPassword: 'newsecret' },
  });
  assert.equal(change.status, 401);
  assert.equal(change.body.error, 'PASSWORD_NOT_SET');
});

test('sign-in attempts are counted per number on both logins, however it is written', async () => {
  assert.equal(loginIdentifierOf({ body: { phone: '+91 98222 00007' } }), '9822200007');
  assert.equal(loginIdentifierOf({ body: { mobile: '919822200007' } }), '9822200007');
  assert.equal(loginIdentifierOf({ body: { mobile: 'amit.owner' } }), 'amit.owner');

  for (let i = 0; i < 20; i += 1) {
    const r = await api('POST', '/auth/employee/login', { body: { phone: '9822200007', password: 'x' } });
    assert.equal(r.status, 401);
  }
  const limited = await api('POST', '/auth/employee/login', { body: { phone: '9822200007', password: 'x' } });
  assert.equal(limited.status, 429);
  const sameBucket = await api('POST', '/auth/login', { body: { mobile: '+91 98222 00007', mpin: '1234' } });
  assert.equal(sameBucket.status, 429, 'switching endpoint or format buys no extra guesses');
});

test('decorating a number with letters or symbols buys no extra guesses: the counter reads it as the login does', async () => {
  const spellings = [
    'a9822200017', 'b9822200017', '9822200017.', 'x98222-00017', '#9822200017', '9822200017z',
    'tel:9822200017', '98222 00017!', '(+91)9822200017?', 'abc919822200017', '9822200017abc', 'mpin9822200017',
    '0-9822200017', 'Q9822200017', '9822200017_', '..9822200017', 'phone=9822200017', '9822200017/',
    '*9822200017*', 'y 9822200017', 'zz9822200017zz', 'last9822200017',
  ];
  // Every one of them is that number to the login, and so to the counter.
  for (const mobile of spellings) {
    assert.deepEqual(loginLookupOf(mobile), { phone: '9822200017' }, mobile);
    assert.equal(loginIdentifierOf({ body: { mobile } }), '9822200017', mobile);
  }

  for (const mobile of spellings.slice(0, 20)) {
    const attempt = await api('POST', '/auth/login', { body: { mobile, mpin: '0000' } });
    assert.equal(attempt.status, 401, mobile);
  }
  for (const mobile of spellings.slice(20)) {
    const limited = await api('POST', '/auth/login', { body: { mobile, mpin: '0000' } });
    assert.equal(limited.status, 429, `${mobile}: the 21st attempt on the number is refused`);
  }
  const plain = await api('POST', '/auth/employee/login', { body: { phone: '9822200017', password: 'x' } });
  assert.equal(plain.status, 429, 'and so is the same number on the other login');

  // A login decorated this way reaches the account, which is why it must count.
  const session = await registrationService.login('ravi:9811100001', { mpin: '2468' });
  assert.equal(session.role, 'EMP');
});

test('editing an employee\'s number re-checks it, excluding themselves', async () => {
  const token = ownerToken(shopA);
  const id = created.ravi._id;

  const clash = await api('PUT', `/employees/${id}`, { token, body: { phone: OWNER_B_PHONE } });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.message, 'This number is already registered');
  assert.equal((await Employee.findById(id).lean()).phone, '9811100001');
  assert.equal((await BusinessUser.findOne({ employeeId: id }).lean()).phone, '9811100001');

  const same = await api('PUT', `/employees/${id}`, { token, body: { phone: '9811100001', name: 'Ravi K' } });
  assert.equal(same.status, 200, 'keeping one\'s own number is not a clash');

  const moved = await api('PUT', `/employees/${id}`, { token, body: { phone: '98111 00005' } });
  assert.equal(moved.status, 200);
  const account = await BusinessUser.findOne({ employeeId: id }).lean();
  assert.equal(account.phone, '9811100005');
  assert.equal(account.fullName, 'Ravi K');
  const freed = await api('GET', '/employees/check-phone?phone=9811100001', { token });
  assert.equal(freed.body.data.available, true, 'the old number is free again');
  assert.equal((await api('POST', '/auth/login', { body: { mobile: '9811100005', mpin: '2468' } })).status, 200);

  const otherShop = await api('PUT', `/employees/${id}`, { token: ownerToken(shopB), body: { name: 'Hijack' } });
  assert.equal(otherShop.status, 404);
});

test('the roster never carries a credential, and an employee sees only themselves', async () => {
  const roster = await api('GET', '/employees', { token: ownerToken(shopA) });
  assert.equal(roster.status, 200);
  const text = JSON.stringify(roster.body);
  for (const secret of ['passwordHash', 'mpinHash', 'mpinVault']) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.ok(roster.body.data.length >= 3);

  const session = await registrationService.login('9811100005', { mpin: '2468' });
  const own = await api('GET', '/employees', { token: session.accessToken });
  assert.deepEqual(own.body.data.map((e) => e._id), [created.ravi._id]);
});

test('a change to the owner\'s GSTIN reaches every employee record of the shop', async () => {
  const session = { businessId: String(shopA.id), userId: String(shopA.ownerId) };
  const { editToken } = await profileEditService.startProfileEdit(session, OWNER_A_MPIN);
  await profileEditService.applyProfileChanges(session, { editToken, otp: '123456', gstNumber: '27ZZZZZ9999Z1Z5' });

  const owner = await BusinessUser.findById(shopA.ownerId).lean();
  assert.equal(owner.gstNumber, '27ZZZZZ9999Z1Z5');
  const employees = await BusinessUser.find({ businessId: shopA.id, role: 'EMP' }).lean();
  assert.ok(employees.length >= 3);
  for (const account of employees) {
    assert.equal(account.gstNumber, '27ZZZZZ9999Z1Z5');
    assert.equal(account.businessName, 'New Trade Name');
    assert.equal(account.address, '9 New Market Road, Pune 411001');
  }
  // The other shop's records are not touched.
  const otherShop = await BusinessUser.findById(shopB.ownerId).lean();
  assert.equal(otherShop.gstNumber, '07BBBBB1111B1Z5');
});

test('an owner record left on an old GSTIN is healed before the employee copies it, and logins heal what fell behind', async () => {
  // Shop C changed its GSTIN before the Profile screen also wrote the user
  // records: the business is on the new GSTIN, the owner's copy on the old one.
  const shopC = { id: new mongoose.Types.ObjectId() };
  const CURRENT = { gstNumber: '24CCCCC3333C1Z5', businessName: 'Current Trade Name', address: '4 Ring Road, Surat 395002' };
  const OLD = { gstNumber: '24OOOOO0000O1Z5', businessName: 'Old Trade Name', address: 'Old address, Surat' };
  await Business.create({
    _id: shopC.id,
    gstNumber: CURRENT.gstNumber,
    legalName: 'CURRENT LEGAL NAME',
    tradeName: CURRENT.businessName,
    businessType: 'Retailer',
    gstStatus: 'Active',
    address: CURRENT.address,
    isRegistered: true,
  });
  const ownerC = await BusinessUser.create({
    businessId: shopC.id,
    phone: '9000000003',
    ...OLD,
    mpinHash: await bcrypt.hash('3333', 10),
    passwordHash: await bcrypt.hash('3333', 10),
    role: 'OWNER',
  });
  shopC.ownerId = ownerC._id;
  await OrganizationLicense.create({
    businessId: shopC.id, ownerUserId: ownerC._id, ownerPhone: '9000000003', licenseStatus: 'PERMANENT_LICENSE',
  });
  const shopDetails = (doc) => ({ gstNumber: doc.gstNumber, businessName: doc.businessName, address: doc.address });

  const add = await api('POST', '/employees', {
    token: ownerToken(shopC),
    body: { name: 'Surat Staff', phone: '9833300001', designation: 'Sales', mpin: '4545', confirmMpin: '4545' },
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const employeeId = add.body.data.employee._id;

  // The employee's record carries the shop's current details, and the owner's
  // record was brought up to date on the way.
  const account = await BusinessUser.findOne({ employeeId }).lean();
  assert.deepEqual(shopDetails(account), CURRENT);
  assert.deepEqual(shopDetails(await BusinessUser.findById(ownerC._id).lean()), CURRENT);

  // Both logins say the same about the shop.
  const employeeLogin = await api('POST', '/auth/login', { body: { mobile: '9833300001', mpin: '4545' } });
  assert.equal(employeeLogin.status, 200, JSON.stringify(employeeLogin.body));
  const ownerLogin = await api('POST', '/auth/login', { body: { mobile: '9000000003', mpin: '3333' } });
  assert.equal(ownerLogin.status, 200);
  assert.deepEqual(shopDetails(employeeLogin.body.data), CURRENT);
  assert.deepEqual(shopDetails(ownerLogin.body.data), CURRENT);

  // Every record of the shop falls behind again: the owner's next login heals
  // their own record and every employee record of the shop.
  await BusinessUser.updateMany({ businessId: shopC.id }, { $set: OLD });
  assert.equal((await api('POST', '/auth/login', { body: { mobile: '9000000003', mpin: '3333' } })).status, 200);
  assert.deepEqual(shopDetails(await BusinessUser.findById(ownerC._id).lean()), CURRENT);
  assert.deepEqual(shopDetails(await BusinessUser.findOne({ employeeId }).lean()), CURRENT);

  // Only the employee's copy behind: their own login heals it and says the current details.
  await BusinessUser.updateOne({ employeeId }, { $set: OLD });
  const again = await api('POST', '/auth/login', { body: { mobile: '9833300001', mpin: '4545' } });
  assert.equal(again.status, 200);
  assert.deepEqual(shopDetails(again.body.data), CURRENT);
  assert.deepEqual(shopDetails(await BusinessUser.findOne({ employeeId }).lean()), CURRENT);

  // A blank on the business never clears what the owner's record has.
  await Business.updateOne({ _id: shopC.id }, { $set: { address: '' } });
  assert.equal((await employeeAccounts.shopDetailsOf(shopC.id)).address, CURRENT.address);
  assert.equal((await BusinessUser.findById(ownerC._id).lean()).address, CURRENT.address);

  // Shop A and B records were never touched by any of this.
  assert.equal((await BusinessUser.findById(shopA.ownerId).lean()).gstNumber, '27ZZZZZ9999Z1Z5');
  assert.equal((await BusinessUser.findById(shopB.ownerId).lean()).gstNumber, '07BBBBB1111B1Z5');
});

test('deleting an employee deletes their sign-in record and frees the number', async () => {
  const token = ownerToken(shopA);
  const id = created.sita._id;

  assert.equal((await api('DELETE', `/employees/${id}`, { token: ownerToken(shopB) })).status, 404);
  assert.ok(await BusinessUser.exists({ employeeId: id }), 'another shop\'s owner removed nothing');

  const removed = await api('DELETE', `/employees/${id}`, { token });
  assert.equal(removed.status, 200);
  assert.equal(await Employee.exists({ _id: id }), null);
  assert.equal(await BusinessUser.exists({ employeeId: id }), null);
  assert.equal((await api('GET', '/employees/check-phone?phone=9811100002', { token })).body.data.available, true);
  assert.equal((await api('POST', '/auth/login', { body: { mobile: '9811100002', mpin: '7788' } })).status, 401);
});

test('an employee deleting their own account removes their sign-in record too', async () => {
  const employee = await Employee.findOne({ phone: '9811100003' });
  const result = await accountDeletionService.deleteAccount({
    businessId: String(shopA.id),
    userId: String(employee._id),
    role: 'EMP',
  });
  assert.equal(result.success, true);
  assert.equal(await Employee.exists({ _id: employee._id }), null);
  assert.equal(await BusinessUser.exists({ employeeId: employee._id }), null);
  assert.ok(await BusinessUser.exists({ _id: shopA.ownerId }), 'the owner is untouched');
});

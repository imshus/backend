/**
 * Proving an employee's number before it is written.
 *
 * The owner sends a code to the number being added (POST
 * /employees/phone-otp), types it in (POST /employees/phone-otp/verify) and
 * gets a token naming that shop and that number, which adding the employee —
 * or moving one to a new number — has to carry. Without it the server refuses
 * with EMPLOYEE_PHONE_NOT_VERIFIED, whose message tells builds without the OTP
 * step to update.
 *
 * Runs the real routes, the real otp.service and a real (in-memory) MongoDB.
 * MSG91 is the only thing stubbed: axios.post answers as MSG91 would, and the
 * code is read from what would have been sent. No SMS leaves this process.
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
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Business = require('../src/models/business.model');
const BusinessUser = require('../src/models/businessUser.model');
const Employee = require('../src/models/employee.model');
const OrganizationLicense = require('../src/models/organizationLicense.model');
const OtpVerification = require('../src/models/otpVerification.model');
const authService = require('../src/services/auth.service');
const otpService = require('../src/services/otp.service');
const registrationService = require('../src/services/registration.service');
const redisClient = require('../src/redis/redisClient');
const { normalizeIndianMobile } = require('../src/utils/phone');
const {
  signEmployeePhoneToken,
  isEmployeePhoneVerified,
} = require('../src/utils/employeePhoneToken');

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
  if (msg91.mode === 'down') {
    const error = new Error('Request failed with status code 503');
    error.response = { status: 503, data: { message: 'Service Unavailable' } };
    throw error;
  }
  return { status: 200, data: { type: 'success', request_id: `req-${msg91.sent.length}` } };
};

/** The code that was texted to a number most recently, however the number is written. */
const lastCodeTo = (phone) => {
  const mobile = `91${normalizeIndianMobile(phone)}`;
  return [...msg91.sent].reverse().find((sms) => sms.mobile === mobile)?.otp;
};

let mongoServer;
let server;
let baseUrl;

const shopA = { id: new mongoose.Types.ObjectId() };
const shopB = { id: new mongoose.Types.ObjectId() };
const OWNER_A_PHONE = '9100000001';
const OWNER_B_PHONE = '9100000002';
const ACCESS_SECRET = 'test-access-secret';

const NOT_VERIFIED = {
  success: false,
  error: 'EMPLOYEE_PHONE_NOT_VERIFIED',
  message: "Verify the employee's phone number with the OTP sent to it. If you don't see an OTP step, update the MRPscan app.",
};
const PHONE_TAKEN = {
  success: false,
  error: 'PHONE_ALREADY_REGISTERED',
  message: 'This number is already registered',
};

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

const sendCode = (shop, phone) => api('POST', '/employees/phone-otp', { token: ownerToken(shop), body: { phone } });
const checkCode = (shop, phone, otp) =>
  api('POST', '/employees/phone-otp/verify', { token: ownerToken(shop), body: { phone, otp } });

/** The whole round trip, as the app makes it: send, read the SMS, verify. */
async function proveNumber(shop, phone) {
  const sent = await sendCode(shop, phone);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const checked = await checkCode(shop, phone, lastCodeTo(phone));
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  return checked.body.data.phoneVerificationToken;
}

async function counts() {
  const [employees, users] = await Promise.all([Employee.countDocuments(), BusinessUser.countDocuments()]);
  return { employees, users };
}

const newEmployee = (phone, extra = {}) => ({
  name: 'Kiran',
  phone,
  designation: 'Sales',
  mpin: '2580',
  confirmMpin: '2580',
  ...extra,
});

test.before(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([BusinessUser.init(), Employee.init()]);

  await Business.create([
    {
      _id: shopA.id,
      gstNumber: '27AAAAA0000A1Z5',
      legalName: 'SHREE JEWELLERS PVT LTD',
      tradeName: 'Shree Jewellers',
      businessType: 'Retailer',
      gstStatus: 'Active',
      address: '12 Zaveri Bazaar, Mumbai 400002',
      isRegistered: true,
    },
    {
      _id: shopB.id,
      gstNumber: '07BBBBB1111B1Z5',
      legalName: 'OTHER SHOP',
      tradeName: 'Other Shop',
      businessType: 'Retailer',
      gstStatus: 'Active',
      address: 'Karol Bagh, Delhi',
      isRegistered: true,
    },
  ]);
  const ownerA = await BusinessUser.create({
    businessId: shopA.id,
    phone: OWNER_A_PHONE,
    gstNumber: '27AAAAA0000A1Z5',
    businessName: 'Shree Jewellers',
    address: '12 Zaveri Bazaar, Mumbai 400002',
    mpinHash: await bcrypt.hash('1111', 10),
    passwordHash: await bcrypt.hash('1111', 10),
    role: 'OWNER',
  });
  shopA.ownerId = ownerA._id;
  const ownerB = await BusinessUser.create({
    businessId: shopB.id,
    phone: OWNER_B_PHONE,
    gstNumber: '07BBBBB1111B1Z5',
    businessName: 'Other Shop',
    address: 'Karol Bagh, Delhi',
    mpinHash: await bcrypt.hash('2222', 10),
    passwordHash: await bcrypt.hash('2222', 10),
    role: 'OWNER',
  });
  shopB.ownerId = ownerB._id;
  await OrganizationLicense.create([
    { businessId: shopA.id, ownerUserId: ownerA._id, ownerPhone: OWNER_A_PHONE, licenseStatus: 'PERMANENT_LICENSE' },
    { businessId: shopB.id, ownerUserId: ownerB._id, ownerPhone: OWNER_B_PHONE, licenseStatus: 'PERMANENT_LICENSE' },
  ]);
  // An active employee of shop B from before sign-in records: their number is taken.
  await Employee.create({ businessId: shopB.id, name: 'Old Karigar', phone: '9811100009' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/employees', require('../src/routes/employee.routes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('sending a code texts the number once, stores it for this shop, and never answers with the code', async () => {
  msg91.mode = 'ok';
  const before = msg91.sent.length;
  const { status, body } = await sendCode(shopA, '+91 98200 00001');

  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, {
    success: true,
    data: { phone: '9820000001', expiresInSeconds: 600, resendAfterSeconds: 30 },
  });
  assert.equal(msg91.sent.length, before + 1);
  const code = lastCodeTo('9820000001');
  assert.match(code, /^[0-9]{6}$/);
  assert.equal(JSON.stringify(body).includes(code), false, 'the code goes to the phone only');

  const record = await OtpVerification.findOne({ mobile: '9820000001' }).sort({ createdAt: -1 }).lean();
  assert.equal(record.flow, 'EMPLOYEE_PHONE');
  assert.equal(record.otpType, 'PHONE');
  assert.equal(String(record.businessId), String(shopA.id));
  assert.equal(record.destination, '9820000001');
  assert.equal(record.status, 'SENT');
  const lifeMs = new Date(record.expiresAt).getTime() - Date.now();
  assert.ok(lifeMs > 9 * 60 * 1000 && lifeMs <= 10 * 60 * 1000, 'ten minutes');
});

test('a number that is already anyone\'s is a 409 and nothing is texted', async () => {
  const before = msg91.sent.length;
  const records = await OtpVerification.countDocuments();
  for (const phone of [OWNER_A_PHONE, OWNER_B_PHONE, '9811100009', '+91 91000 00002']) {
    const { status, body } = await sendCode(shopA, phone);
    assert.equal(status, 409, phone);
    assert.deepEqual(body, PHONE_TAKEN, phone);
  }
  assert.equal(msg91.sent.length, before, 'no SMS');
  assert.equal(await OtpVerification.countDocuments(), records, 'no code stored');
});

test('MSG91 refusing or unreachable is a 502 OTP_SEND_FAILED', async () => {
  try {
    for (const mode of ['reject', 'down']) {
      msg91.mode = mode;
      const { status, body } = await sendCode(shopA, '9820000002');
      assert.equal(status, 502, mode);
      assert.equal(body.success, false);
      assert.equal(body.error, 'OTP_SEND_FAILED');
      assert.equal(typeof body.message, 'string');
      assert.equal(/MSG91/i.test(body.message), false, 'a plain message, not the provider\'s');
    }
  } finally {
    msg91.mode = 'ok';
  }
  const record = await OtpVerification.findOne({ mobile: '9820000002' }).sort({ createdAt: -1 }).lean();
  assert.equal(record.status, 'FAILED');
});

test('only the owner may send or check a code, and only for a real number', async () => {
  const employee = authService.generateTokens(String(shopA.id), String(new mongoose.Types.ObjectId()), 'EMP').accessToken;
  const asEmployee = await api('POST', '/employees/phone-otp', { token: employee, body: { phone: '9820000003' } });
  assert.equal(asEmployee.status, 403);
  const checkAsEmployee = await api('POST', '/employees/phone-otp/verify', {
    token: employee, body: { phone: '9820000003', otp: '123456' },
  });
  assert.equal(checkAsEmployee.status, 403);
  assert.equal((await api('POST', '/employees/phone-otp', { body: { phone: '9820000003' } })).status, 401);

  const bad = await sendCode(shopA, '12345');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'VALIDATION_ERROR');
  const badCode = await checkCode(shopA, '9820000003', '12ab');
  assert.equal(badCode.status, 400);
  assert.equal(badCode.body.error, 'VALIDATION_ERROR');
});

test('the right code returns a 30-minute token for this shop and this number', async () => {
  await sendCode(shopA, '9820000004');
  const { status, body } = await checkCode(shopA, '98200 00004', lastCodeTo('9820000004'));

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.data.expiresInSeconds, 1800);
  const token = body.data.phoneVerificationToken;
  const claims = jwt.verify(token, ACCESS_SECRET);
  assert.equal(claims.typ, 'employee-phone');
  assert.equal(claims.businessId, String(shopA.id));
  assert.equal(claims.phone, '9820000004');
  assert.equal(claims.exp - claims.iat, 1800);

  assert.equal(isEmployeePhoneVerified(token, { businessId: String(shopA.id), phone: '+91 98200 00004' }), true);
  assert.equal(isEmployeePhoneVerified(token, { businessId: String(shopB.id), phone: '9820000004' }), false);
  assert.equal(isEmployeePhoneVerified(token, { businessId: String(shopA.id), phone: '9820000005' }), false);
});

test('a wrong code is "Wrong OTP", the right one still works, and only once', async () => {
  await sendCode(shopA, '9820000006');
  const code = lastCodeTo('9820000006');
  const wrongCode = code === '000000' ? '111111' : '000000';

  const wrong = await checkCode(shopA, '9820000006', wrongCode);
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body, { success: false, error: 'OTP_INVALID', message: 'Wrong OTP' });

  const right = await checkCode(shopA, '9820000006', code);
  assert.equal(right.status, 200);

  const again = await checkCode(shopA, '9820000006', code);
  assert.equal(again.status, 400);
  assert.equal(again.body.error, 'OTP_ALREADY_USED');
  assert.equal(typeof again.body.message, 'string');
});

test('an expired code is OTP_EXPIRED', async () => {
  await sendCode(shopA, '9820000007');
  const code = lastCodeTo('9820000007');

  // Eleven minutes on, for the length of one check (the server runs in this
  // process). Moving the clock rather than the record keeps MongoDB's TTL
  // monitor from deleting the record mid-test.
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  let late;
  try {
    late = await checkCode(shopA, '9820000007', code);
  } finally {
    Date.now = realNow;
  }
  assert.equal(late.status, 400);
  assert.deepEqual(late.body, { success: false, error: 'OTP_EXPIRED', message: 'OTP expired, send a new one' });
});

test('no code sent is OTP_NOT_FOUND', async () => {
  const { status, body } = await checkCode(shopA, '9820000008', '123456');
  assert.equal(status, 400);
  assert.equal(body.error, 'OTP_NOT_FOUND');
  assert.equal(typeof body.message, 'string');
});

test('a code another shop asked for never verifies here', async () => {
  // Shop B texts the number; shop A, holding B's code, has sent nothing.
  await sendCode(shopB, '9820000009');
  const codeB = lastCodeTo('9820000009');
  const borrowed = await checkCode(shopA, '9820000009', codeB);
  assert.equal(borrowed.status, 400);
  assert.equal(borrowed.body.error, 'OTP_NOT_FOUND');

  // Shop A sends its own, then shop B sends again: B's later code is not A's
  // latest, and does not hide A's.
  await sendCode(shopA, '9820000009');
  const codeA = lastCodeTo('9820000009');
  await sendCode(shopB, '9820000009');
  const laterB = lastCodeTo('9820000009');
  if (laterB !== codeA) {
    const crossed = await checkCode(shopA, '9820000009', laterB);
    assert.equal(crossed.status, 400);
    assert.equal(crossed.body.error, 'OTP_INVALID');
  }
  const own = await checkCode(shopA, '9820000009', codeA);
  assert.equal(own.status, 200);
  assert.equal(jwt.decode(own.body.data.phoneVerificationToken).businessId, String(shopA.id));

  const ownB = await checkCode(shopB, '9820000009', laterB);
  assert.equal(ownB.status, 200);
  assert.equal(jwt.decode(ownB.body.data.phoneVerificationToken).businessId, String(shopB.id));
});

test('adding an employee needs the token for this shop and this number; with it they are created', async () => {
  const token = ownerToken(shopA);
  const phone = '9820000010';
  const now = Math.floor(Date.now() / 1000);
  const refused = [
    ['no token', undefined],
    ['an empty token', ''],
    ['a token for another number', signEmployeePhoneToken({ businessId: String(shopA.id), phone: '9820000011' })],
    ['a token another shop proved', signEmployeePhoneToken({ businessId: String(shopB.id), phone })],
    ['an expired token', jwt.sign(
      { typ: 'employee-phone', businessId: String(shopA.id), phone, iat: now - 3600, exp: now - 1800 },
      ACCESS_SECRET,
    )],
    ['a sign-in token instead', token],
    ['a token signed with another secret', jwt.sign({ typ: 'employee-phone', businessId: String(shopA.id), phone }, 'not-the-secret')],
    ['garbage', 'not-a-token'],
  ];

  for (const [label, phoneVerificationToken] of refused) {
    const before = await counts();
    const body = newEmployee(phone, phoneVerificationToken === undefined ? {} : { phoneVerificationToken });
    const { status, body: answer } = await api('POST', '/employees', { token, body });
    assert.equal(status, 403, label);
    assert.deepEqual(answer, NOT_VERIFIED, label);
    assert.deepEqual(await counts(), before, `${label}: nothing written`);
  }

  const proof = await proveNumber(shopA, '+91 98200 00010');
  const { status, body } = await api('POST', '/employees', {
    token,
    body: newEmployee('98200 00010', { phoneVerificationToken: proof }),
  });
  assert.equal(status, 201, JSON.stringify(body));
  created.kiran = body.data.employee;
  assert.equal(created.kiran.phone, phone);
  const account = await BusinessUser.findOne({ employeeId: created.kiran._id }).lean();
  assert.equal(account.role, 'EMP');
  assert.equal(account.phone, phone);
});

test('older builds: the draft step still works, but finishing it needs the same token', async () => {
  const token = ownerToken(shopA);
  const draft = await api('POST', '/employees', { token, body: { name: 'Draft Person', phone: '9820000012' } });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.message, 'Draft saved successfully');

  const before = await counts();
  const unproved = await api('POST', '/employees', { token, body: { password: 'secret12' } });
  assert.equal(unproved.status, 403);
  assert.deepEqual(unproved.body, NOT_VERIFIED);
  assert.deepEqual(await counts(), before);
  assert.notEqual(await redisClient.get(`emp_draft:${shopA.id}`), null, 'the draft is kept');

  const proved = await api('POST', '/employees', {
    token,
    body: { password: 'secret12', phoneVerificationToken: await proveNumber(shopA, '9820000012') },
  });
  assert.equal(proved.status, 201, JSON.stringify(proved.body));
  assert.equal(proved.body.data.employee.phone, '9820000012');
});

test('changing an employee\'s number needs the token for the new number; the same number needs none', async () => {
  const token = ownerToken(shopA);
  const id = created.kiran._id;
  const storedPhones = async () => ({
    employee: (await Employee.findById(id).lean()).phone,
    account: (await BusinessUser.findOne({ employeeId: id }).lean()).phone,
  });

  for (const [label, extra] of [
    ['no token', {}],
    ['a token for the old number', { phoneVerificationToken: signEmployeePhoneToken({ businessId: String(shopA.id), phone: '9820000010' }) }],
    ['a token another shop proved', { phoneVerificationToken: signEmployeePhoneToken({ businessId: String(shopB.id), phone: '9820000013' }) }],
  ]) {
    const refused = await api('PUT', `/employees/${id}`, { token, body: { phone: '9820000013', name: 'Kiran R', ...extra } });
    assert.equal(refused.status, 403, label);
    assert.deepEqual(refused.body, NOT_VERIFIED, label);
    assert.deepEqual(await storedPhones(), { employee: '9820000010', account: '9820000010' }, `${label}: unchanged`);
    assert.equal((await Employee.findById(id).lean()).name, 'Kiran', `${label}: nothing else written either`);
  }

  const moved = await api('PUT', `/employees/${id}`, {
    token,
    body: { phone: '+91 98200 00013', phoneVerificationToken: await proveNumber(shopA, '9820000013') },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(await storedPhones(), { employee: '9820000013', account: '9820000013' });

  // The same number however written, or no number at all: no token needed.
  const same = await api('PUT', `/employees/${id}`, { token, body: { phone: '+91 98200 00013', name: 'Kiran R' } });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.data.name, 'Kiran R');
  const nameOnly = await api('PUT', `/employees/${id}`, { token, body: { designation: 'Karigar' } });
  assert.equal(nameOnly.status, 200);
  assert.deepEqual(await storedPhones(), { employee: '9820000013', account: '9820000013' });
});

test('codes to one number are capped per shop: 10 sends and 15 checks an hour, however the number is written', async () => {
  const phone = '9820000020';
  for (let i = 0; i < 10; i += 1) {
    const sent = await sendCode(shopA, i % 2 ? phone : '+91 98200 00020');
    assert.equal(sent.status, 200, `send ${i + 1}`);
  }
  const codeA = lastCodeTo(phone);
  const before = msg91.sent.length;
  const limited = await sendCode(shopA, '919820000020');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'RATE_LIMIT_EXCEEDED');
  assert.equal(msg91.sent.length, before, 'nothing texted past the cap');

  const wrongCode = codeA === '000000' ? '111111' : '000000';
  for (let i = 0; i < 15; i += 1) {
    const wrong = await checkCode(shopA, phone, wrongCode);
    assert.equal(wrong.status, 400, `check ${i + 1}`);
  }
  const blocked = await checkCode(shopA, '98200 00020', codeA);
  assert.equal(blocked.status, 429, 'not even the right code past the cap');

  // Shop A having spent its sends and checks on the number leaves shop B's
  // untouched: B can still text it and prove it.
  const sentB = await sendCode(shopB, phone);
  assert.equal(sentB.status, 200, JSON.stringify(sentB.body));
  const checkedB = await checkCode(shopB, phone, lastCodeTo(phone));
  assert.equal(checkedB.status, 200, JSON.stringify(checkedB.body));
});

test('one shop\'s wrong guesses at a number never lock another shop out of it', async () => {
  const phone = '9820000021';
  await sendCode(shopB, phone);
  const codeB = lastCodeTo(phone);
  const wrongCode = codeB === '000000' ? '111111' : '000000';
  for (let i = 0; i < 16; i += 1) await checkCode(shopA, phone, wrongCode);

  const own = await checkCode(shopB, phone, codeB);
  assert.equal(own.status, 200, JSON.stringify(own.body));
});

test('an employee stored under an old spelling of their number is edited without a code', async () => {
  const token = ownerToken(shopA);
  const legacy = await Employee.create({ businessId: shopA.id, name: 'Old Spelling', phone: '09820000030' });

  // The app sends the number back as the ten digits it shows.
  const edited = await api('PUT', `/employees/${legacy._id}`, {
    token, body: { phone: '9820000030', name: 'Old Spelling R' },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const stored = await Employee.findById(legacy._id).lean();
  assert.equal(stored.name, 'Old Spelling R');
  assert.equal(stored.phone, '9820000030');

  // Another number still needs its code.
  const moved = await api('PUT', `/employees/${legacy._id}`, { token, body: { phone: '9820000031' } });
  assert.equal(moved.status, 403);
  assert.deepEqual(moved.body, NOT_VERIFIED);
});

test('a code a shop texted to an employee is never that shop\'s sign-up phone proof', async () => {
  // Someone holding shop B's id restarts its sign-up with a number they do
  // not hold; the sign-up code goes there. Then B's owner texts a code to the
  // number of someone being added, who can read it.
  const businessId = String(shopB.id);
  const signupPhone = '9820000040';
  const employeePhone = '9820000041';
  try {
    await registrationService.submitContactDetails(businessId, signupPhone);
    const signupCode = lastCodeTo(signupPhone);
    await sendCode(shopB, employeePhone);
    const employeeCode = lastCodeTo(employeePhone);

    if (employeeCode !== signupCode) {
      await assert.rejects(
        () => registrationService.verifyPhoneOtp(businessId, employeeCode),
        { message: 'OTP_INVALID' },
      );
    }
    const before = await counts();
    await assert.rejects(
      () => registrationService.createPassword(businessId, undefined, undefined, 'Intruder', undefined, '1234'),
      { message: 'Please verify mobile number first' },
    );
    assert.deepEqual(await counts(), before, 'no owner added to shop B');

    // The sign-up code still proves its own number, and the owner's code was
    // neither read nor spent.
    assert.deepEqual(await registrationService.verifyPhoneOtp(businessId, signupCode), { phoneVerified: true });
    const checked = await checkCode(shopB, employeePhone, employeeCode);
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
  } finally {
    await redisClient.del(`registration:${businessId}`);
  }
});

test('a number the owner proved is not proved for anyone\'s own sign-up', async () => {
  const phone = '9820000042';
  await proveNumber(shopA, phone);
  const fresh = await Business.create({
    gstNumber: '29CCCCC2222C1Z5',
    legalName: 'FRESH SHOP',
    tradeName: 'Fresh Shop',
    businessType: 'Retailer',
    gstStatus: 'Active',
    address: 'Bengaluru',
    isRegistered: false,
  });

  const before = await counts();
  await assert.rejects(
    () => registrationService.register({
      mobile: phone,
      mpin: '1234',
      businessDetails: { businessId: String(fresh._id) },
    }),
    { message: 'Please verify mobile number first' },
  );
  assert.deepEqual(await counts(), before, 'no account on the number');
});

test('the sign-in checks never read a shop\'s code to an employee, nor let it hide the number\'s own', async () => {
  const phone = '9820000043';
  await otpService.sendMobileOtp({ mobile: phone, flow: 'LOGIN' });
  const loginCode = lastCodeTo(phone);
  await sendCode(shopA, phone);
  const employeeCode = lastCodeTo(phone);

  if (employeeCode !== loginCode) {
    await assert.rejects(
      () => otpService.verifyOtpByMobile({ mobile: phone, otp: employeeCode }),
      { message: 'OTP_INVALID' },
    );
  }
  const own = await otpService.verifyOtpByMobile({ mobile: phone, otp: loginCode });
  assert.equal(own.verified, true);

  const checked = await checkCode(shopA, phone, employeeCode);
  assert.equal(checked.status, 200, 'the owner\'s code was not spent');
});

test('neither the phone proof nor a password-reset token is ever a session', async () => {
  const proof = await proveNumber(shopA, '9820000044');
  const reset = authService.generatePasswordResetToken(String(shopA.id), String(shopA.ownerId), 'nonce-1');
  for (const [label, token] of [['the phone proof', proof], ['a reset token', reset]]) {
    const { status } = await api('GET', '/employees', { token });
    assert.equal(status, 401, label);
  }
  assert.equal((await api('GET', '/employees', { token: ownerToken(shopA) })).status, 200);
});

test('a resend MSG91 refused never hides the code the employee already received', async () => {
  const phone = '9822200031';
  assert.equal((await sendCode(shopA, phone)).status, 200);
  const delivered = lastCodeTo(phone);
  msg91.mode = 'reject';
  try {
    assert.equal((await sendCode(shopA, phone)).status, 502);
  } finally {
    msg91.mode = 'ok';
  }
  const checked = await checkCode(shopA, phone, delivered);
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.ok(checked.body.data.phoneVerificationToken);
});

test('a shop that may not add another employee is told before any SMS; a number change is not an add', async () => {
  // Shop B has one employee; without a licence it may not add a second.
  await OrganizationLicense.updateOne({ businessId: shopB.id }, { licenseStatus: 'NO_LICENSE' });
  try {
    const before = msg91.sent.length;
    const refused = await sendCode(shopB, '9822200032');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'TRIAL_REQUIRED_FOR_MORE_EMPLOYEES');
    assert.equal(msg91.sent.length, before, 'no SMS for an add the shop cannot make');

    const karigar = await Employee.findOne({ businessId: shopB.id, name: 'Old Karigar' });
    const change = await api('POST', '/employees/phone-otp', {
      token: ownerToken(shopB),
      body: { phone: '9822200033', employeeId: String(karigar._id) },
    });
    assert.equal(change.status, 200, JSON.stringify(change.body));

    // Another shop's employee id does not lift the limit.
    const stranger = await api('POST', '/employees/phone-otp', {
      token: ownerToken(shopB),
      body: { phone: '9822200034', employeeId: String(new mongoose.Types.ObjectId()) },
    });
    assert.equal(stranger.status, 403);
  } finally {
    await OrganizationLicense.updateOne({ businessId: shopB.id }, { licenseStatus: 'PERMANENT_LICENSE' });
  }
});

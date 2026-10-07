/**
 * GET /subscription/summary: the plan, the trial and the credits, for anyone
 * signed in to the shop.
 *
 * An employee's Settings screen shows their shop's subscription in place of
 * the owner's business tile, so an EMP token has to be able to read it — but
 * only its own shop's, and only those seven fields. The overview, with the
 * purchase's order, payment and invoice ids, stays the owner's.
 *
 * Runs against a real (in-memory) MongoDB and the real routes, so the auth
 * and role middleware and the tokens are the ones production uses. No paid
 * API is reached.
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
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Business = require('../src/models/business.model');
const BusinessUser = require('../src/models/businessUser.model');
const Employee = require('../src/models/employee.model');
const OrganizationLicense = require('../src/models/organizationLicense.model');
const OrganizationWallet = require('../src/models/organizationWallet.model');
const authService = require('../src/services/auth.service');
const employeeAccounts = require('../src/services/employeeAccount.service');
const errorHandler = require('../src/middleware/errorHandler');

const DAY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_FIELDS = [
  'applicationPurchased',
  'creditBalance',
  'permanentActivatedAt',
  'status',
  'trialDaysRemaining',
  'trialEndDate',
  'trialStatus',
];

// Shop A has bought the application; shop B is five days into its trial;
// shop C's trial ran out yesterday.
const shopA = { id: new mongoose.Types.ObjectId(), phone: '9000000001' };
const shopB = { id: new mongoose.Types.ObjectId(), phone: '9000000002' };
const shopC = { id: new mongoose.Types.ObjectId(), phone: '9000000003' };
const PERMANENT_AT = new Date('2026-06-01T10:00:00.000Z');
// What the purchase left on shop A's licence: none of it is an employee's.
const PURCHASE = {
  purchaseOrderId: 'order_SECRET_A1',
  purchasePaymentId: 'pay_SECRET_A1',
  purchaseInvoiceNumber: 'INV-SECRET-0001',
  purchaseAmount: 14160,
};

let mongoServer;
let server;
let baseUrl;
const tokens = {};

async function api(path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json };
}

const ownerToken = (shop) =>
  authService.generateTokens(String(shop.id), String(shop.ownerId), 'OWNER').accessToken;

async function createShop(shop, name, gstNumber) {
  await Business.create({
    _id: shop.id,
    gstNumber,
    legalName: name.toUpperCase(),
    tradeName: name,
    businessType: 'Retailer',
    gstStatus: 'Active',
    address: `${name}, Mumbai`,
    isRegistered: true,
  });
  const owner = await BusinessUser.create({
    businessId: shop.id,
    phone: shop.phone,
    gstNumber,
    businessName: name,
    address: `${name}, Mumbai`,
    passwordHash: 'x',
    mpinHash: 'x',
    role: 'OWNER',
  });
  shop.ownerId = owner._id;
}

/** The token an employee's real sign-in issues. */
async function employeeOf(shop, name, phone) {
  const employee = await Employee.create({ businessId: shop.id, name, phone });
  const session = await employeeAccounts.employeeSession(employee);
  return { employee, token: session.accessToken };
}

test.before(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongoServer.getUri());

  await createShop(shopA, 'Shree Jewellers', '27AAAAA0000A1Z5');
  await createShop(shopB, 'Other Shop', '07BBBBB1111B1Z5');
  await createShop(shopC, 'Third Shop', '24CCCCC2222C1Z5');

  const now = Date.now();
  shopB.trialEndDate = new Date(now + 5 * DAY_MS);
  await OrganizationLicense.create([
    {
      businessId: shopA.id,
      ownerUserId: shopA.ownerId,
      ownerPhone: shopA.phone,
      licenseStatus: 'PERMANENT_LICENSE',
      permanentActivatedAt: PERMANENT_AT,
      purchaseDate: PERMANENT_AT,
      ...PURCHASE,
    },
    {
      businessId: shopB.id,
      ownerUserId: shopB.ownerId,
      ownerPhone: shopB.phone,
      licenseStatus: 'FREE_TRIAL_LICENSE',
      trialDays: 7,
      trialStartDate: new Date(now - 2 * DAY_MS),
      trialEndDate: shopB.trialEndDate,
    },
    {
      businessId: shopC.id,
      ownerUserId: shopC.ownerId,
      ownerPhone: shopC.phone,
      licenseStatus: 'FREE_TRIAL_LICENSE',
      trialDays: 7,
      trialStartDate: new Date(now - 8 * DAY_MS),
      trialEndDate: new Date(now - DAY_MS),
    },
  ]);
  await OrganizationWallet.create([
    { businessId: shopA.id, creditBalance: 1240 },
    { businessId: shopB.id, creditBalance: 37.5 },
    { businessId: shopC.id, creditBalance: 12 },
  ]);

  tokens.empA = (await employeeOf(shopA, 'Ravi Kumar', '9811100001')).token;
  tokens.empB = (await employeeOf(shopB, 'Sunil Karigar', '9811100002')).token;
  tokens.empC = (await employeeOf(shopC, 'Meena Sales', '9811100003')).token;
  const leaver = await employeeOf(shopA, 'Left Today', '9811100004');
  await Employee.updateOne({ _id: leaver.employee._id }, { $set: { isActive: false } });
  tokens.leaverA = leaver.token;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/subscription', require('../src/routes/subscription.routes'));
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

test("an employee reads their own shop's plan and credits, and nothing else", async () => {
  const { status, body } = await api('/subscription/summary', tokens.empA);

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body.data).sort(), SUMMARY_FIELDS, 'only the contract fields');
  assert.deepEqual(body.data, {
    status: 'PERMANENT_LICENSE',
    trialStatus: 'NOT_STARTED',
    trialDaysRemaining: 0,
    trialEndDate: null,
    applicationPurchased: true,
    permanentActivatedAt: PERMANENT_AT.toISOString(),
    creditBalance: 1240,
  });

  const raw = JSON.stringify(body);
  for (const secret of [...Object.values(PURCHASE).map(String), String(shopA.id), shopA.phone]) {
    assert.equal(raw.includes(secret), false, `${secret} is not an employee's to see`);
  }
});

test('the owner reads the same summary, and it agrees with their overview', async () => {
  const fromEmployee = await api('/subscription/summary', tokens.empA);
  const { status, body } = await api('/subscription/summary', ownerToken(shopA));

  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, fromEmployee.body);

  const overview = await api('/subscription/overview', ownerToken(shopA));
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  for (const field of ['status', 'trialDaysRemaining', 'trialEndDate', 'applicationPurchased', 'permanentActivatedAt', 'creditBalance']) {
    assert.deepEqual(body.data[field], overview.body.data[field], `${field} matches the overview`);
  }
  assert.equal(overview.body.data.purchaseOrderId, PURCHASE.purchaseOrderId, 'the owner still sees the purchase');
});

test("the token's shop is the one read: a trial shop's employee sees their trial", async () => {
  const { status, body } = await api('/subscription/summary', tokens.empB);

  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.data, {
    status: 'FREE_TRIAL_LICENSE',
    trialStatus: 'ACTIVE',
    trialDaysRemaining: 5,
    trialEndDate: shopB.trialEndDate.toISOString(),
    applicationPurchased: false,
    permanentActivatedAt: null,
    creditBalance: 37.5,
  });

  // Nothing in the request can point it at another shop.
  const steered = await api(`/subscription/summary?businessId=${shopA.id}`, tokens.empB);
  assert.equal(steered.status, 200);
  assert.deepEqual(steered.body.data, body.data);
});

test('a trial that has run out reads as expired, with its credits gone', async () => {
  const { status, body } = await api('/subscription/summary', tokens.empC);

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.status, 'NO_LICENSE');
  assert.equal(body.data.trialStatus, 'EXPIRED');
  assert.equal(body.data.trialDaysRemaining, 0);
  assert.equal(body.data.applicationPurchased, false);
  assert.equal(body.data.creditBalance, 0);
});

test('no token is a 401', async () => {
  const { status, body } = await api('/subscription/summary');
  assert.equal(status, 401, JSON.stringify(body));
  assert.equal(body.success, false);
});

test('a token with any other role, or none, is refused', async () => {
  for (const role of ['VIEWER', 'CUSTOMER', '']) {
    const token = authService.generateTokens(String(shopA.id), String(shopA.ownerId), role).accessToken;
    const { status, body } = await api('/subscription/summary', token);
    assert.equal(status, 403, `${role || '(no role)'}: ${JSON.stringify(body)}`);
    assert.equal(body.data, undefined);
  }
});

test('an employee removed from the shop is refused within their token', async () => {
  const { status, body } = await api('/subscription/summary', tokens.leaverA);
  assert.equal(status, 401, JSON.stringify(body));
  assert.equal(body.data, undefined);
});

test('the owner-only subscription routes still refuse an employee', async () => {
  for (const path of ['/subscription/overview', '/subscription/scan-billing', '/subscription/credit-transactions']) {
    const { status, body } = await api(path, tokens.empA);
    assert.equal(status, 403, `${path}: ${JSON.stringify(body)}`);
    assert.equal(body.data, undefined);
  }
});

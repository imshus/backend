/**
 * The name typed on the signup form is what the account is stored under.
 *
 * It used to live only in the app's own storage, so it was gone the next time
 * the phone cleared it and the database never knew who the account belonged
 * to. These tests hold the whole path: register -> createPassword writes it,
 * and a later sign-in hands it back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'registration.service.js');
const SERVICE_DIR = path.dirname(SERVICE);

const state = {
  created: [],
  business: null,
  redis: {},
  otpLatest: null,
  userIdTaken: null,
  phoneTaken: null,
  foundUser: null,
};

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: SERVICE, filename: SERVICE, paths: Module._nodeModulePaths(SERVICE_DIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('../models/businessUser.model', {
  create: async (docs) => {
    const rows = docs.map((doc, index) => ({ ...doc, _id: `user-${index}` }));
    state.created.push(...rows);
    return rows;
  },
  findOne: async (query) => {
    if (query.userId) return state.userIdTaken;
    // Registration asks "is this number taken?"; a sign-in asks "whose is it?".
    if (query.phone) return state.foundUser ?? state.phoneTaken;
    return state.foundUser;
  },
  updateOne: async () => ({}),
});
stub('../models/business.model', {
  findById: async () => state.business,
  findOne: async () => state.business,
  updateOne: async () => ({}),
  findByIdAndUpdate: async () => state.business,
});
stub('../redis/redisClient', {
  get: async (key) => state.redis[key] ?? null,
  set: async (key, value) => { state.redis[key] = value; },
  del: async (key) => { delete state.redis[key]; },
});
stub('./otp.service', {
  verifyOtpByMobile: async () => ({ verified: true }),
  sendPhoneOtp: async () => ({}),
});
stub('../repositories/otp.repository', {
  findLatestByMobile: async () => state.otpLatest,
});
stub('./auth.service', {
  generateTokens: () => ({ accessToken: 'access', refreshToken: 'refresh' }),
});
stub('./license.service', {
  ensureLicense: async () => ({}),
  startTrialWithCredits: async () => ({ started: true }),
});
stub('./wallet.service', { ensureWallet: async () => ({}) });
stub('./referral.service', {
  applyReferralCode: async () => ({}),
  resolveReferralCode: async () => null,
  linkReferral: async () => ({ applied: false }),
});

const registrationService = require(SERVICE);

const BUSINESS = {
  _id: 'business-1',
  address: 'Zaveri Bazaar, Mumbai',
  gstNumber: '27AAACP1234A1Z5',
  tradeName: 'Pratham International',
  legalName: 'Pratham International Pvt Ltd',
  isRegistered: false,
  save: async () => {},
};

const reset = () => {
  state.created = [];
  state.business = { ...BUSINESS, save: async () => {} };
  state.redis = { 'registration:business-1': JSON.stringify({ phone: '9876543210', phoneVerified: true }) };
  state.otpLatest = null;
  state.userIdTaken = null;
  state.phoneTaken = null;
  state.foundUser = null;
};

test('registration stores the name the person signed up with', async () => {
  reset();

  await registrationService.register({
    mobile: '9876543210',
    password: 'Secret@123',
    userId: 'pratham.owner',
    fullName: '  Shudhanshu Kumar  ',
    businessDetails: { businessId: 'business-1', businessName: 'Pratham International' },
  });

  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].fullName, 'Shudhanshu Kumar', 'trimmed and stored on the account');
  assert.equal(state.created[0].userId, 'pratham.owner');
  assert.equal(state.created[0].role, 'OWNER');
});

test('an app that sends no name still registers, with the field left blank', async () => {
  reset();

  await registrationService.register({
    mobile: '9876543210',
    password: 'Secret@123',
    businessDetails: { businessId: 'business-1' },
  });

  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].fullName, '', 'never undefined: the column always exists');
});

test('signing in hands the stored name back to the app', async () => {
  reset();
  state.foundUser = {
    _id: 'user-0',
    businessId: 'business-1',
    userId: 'pratham.owner',
    fullName: 'Shudhanshu Kumar',
    phone: '9876543210',
    role: 'OWNER',
    isActive: true,
    passwordHash: 'hash',
    save: async () => {},
  };
  state.business = { ...BUSINESS, save: async () => {} };

  const payload = await registrationService.loginWithOtp('9876543210', '123456');

  assert.equal(payload.fullName, 'Shudhanshu Kumar');
  assert.equal(payload.businessName, 'Pratham International');
  assert.equal(payload.loginId, 'pratham.owner');
});

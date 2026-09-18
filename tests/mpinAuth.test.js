/**
 * Signing in with a phone number and a 4-digit MPIN.
 *
 * The mockup's onboarding ends in an MPIN rather than a User ID and password,
 * so that is what an owner signs in with. Two things have to stay true through
 * the changeover: a build already on someone's phone still signs in with the
 * User ID and password it knows about, and the accounts that existed before
 * MPINs are not locked out — they are told to set one, over the same OTP as a
 * forgotten MPIN, rather than shown a credential error they cannot act on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { registerSchema, loginSchema, resetMpinSchema } = require('../src/validators/auth.validator');
const BusinessUser = require('../src/models/businessUser.model');
const Business = require('../src/models/business.model');
const registrationService = require('../src/services/registration.service');

/**
 * Stands in for the account the query is expected to find, and for the shop
 * behind it — signing in reads both, and neither is what these tests are
 * about.
 */
function fakeAccount(doc) {
  const original = { findOne: BusinessUser.findOne, findById: Business.findById };
  BusinessUser.findOne = (filter) => {
    const wantsPhone = filter?.phone !== undefined;
    const matches = wantsPhone ? filter.phone === doc.phone : filter?.userId === doc.userId;
    return Promise.resolve(matches ? doc : null);
  };
  Business.findById = () => Promise.resolve({
    _id: 'b1',
    tradeName: 'Test Jewellers',
    legalName: 'Test Jewellers Pvt Ltd',
    gstNumber: '27AAAAA0000A1Z5',
    address: 'Somewhere',
    save: async () => {},
  });
  return () => {
    BusinessUser.findOne = original.findOne;
    Business.findById = original.findById;
  };
}

test('the MPIN must be exactly four digits', () => {
  for (const bad of ['123', '12345', 'abcd', '12a4', '', '  ']) {
    const { error } = loginSchema.validate({ mobile: '9876543210', mpin: bad });
    assert.ok(error, `"${bad}" must be refused`);
  }
  const { error } = loginSchema.validate({ mobile: '9876543210', mpin: '0451' });
  assert.equal(error, undefined, 'a leading zero is a digit like any other');
});

test('signing in needs one credential or the other, never neither', () => {
  const missing = loginSchema.validate({ mobile: '9876543210' }).error;
  assert.ok(missing, 'no credential at all is refused');
  assert.match(missing.message, /MPIN/);

  // The build already on people's phones sends a User ID and a password.
  assert.equal(
    loginSchema.validate({ mobile: 'imshu1', password: 'secret123' }).error,
    undefined,
  );
});

test('registration accepts an MPIN, or the password an older build sends', () => {
  const base = {
    mobile: '9876543210',
    fullName: 'Amit Gupta',
    businessDetails: { businessId: 'b1' },
  };
  assert.equal(registerSchema.validate({ ...base, mpin: '4517' }).error, undefined);
  assert.equal(
    registerSchema.validate({ ...base, password: 'secret123', userId: 'amit' }).error,
    undefined,
  );

  const neither = registerSchema.validate(base).error;
  assert.ok(neither, 'an account cannot be created with no credential');
  assert.match(neither.message, /MPIN/);
});

test('a phone number and the right MPIN sign the owner in', async () => {
  const doc = {
    _id: 'u1',
    businessId: { toString: () => 'b1' },
    phone: '9876543210',
    userId: 'amit',
    role: 'OWNER',
    isActive: true,
    mpinHash: await bcrypt.hash('4517', 10),
    passwordHash: await bcrypt.hash('4517', 10),
    save: async () => {},
  };
  const restore = fakeAccount(doc);
  try {
    // As the app sends it, country code and spaces included.
    const payload = await registrationService.login('+91 98765 43210', { mpin: '4517' });
    assert.ok(payload, 'a session is issued');

    await assert.rejects(
      registrationService.login('9876543210', { mpin: '0000' }),
      /INVALID_PHONE_CREDENTIALS/,
      'the wrong MPIN is refused',
    );
  } finally {
    restore();
  }
});

test('an account with no MPIN is asked to set one, not told it is wrong', async () => {
  const doc = {
    _id: 'u2',
    businessId: { toString: () => 'b1' },
    phone: '9811039977',
    role: 'OWNER',
    isActive: true,
    // Registered before MPINs existed: a password and nothing else.
    passwordHash: await bcrypt.hash('oldpassword', 10),
    save: async () => {},
  };
  const restore = fakeAccount(doc);
  try {
    await assert.rejects(
      registrationService.login('9811039977', { mpin: '1234' }),
      /MPIN_NOT_SET/,
      'the shop is sent to set an MPIN rather than refused',
    );
  } finally {
    restore();
  }
});

test('the User ID and password an older build sends still work', async () => {
  const doc = {
    _id: 'u3',
    businessId: { toString: () => 'b1' },
    phone: '9760522365',
    userId: 'cgupta',
    role: 'OWNER',
    isActive: true,
    passwordHash: await bcrypt.hash('cgupta-secret', 10),
    save: async () => {},
  };
  const restore = fakeAccount(doc);
  try {
    const payload = await registrationService.login('cgupta', { password: 'cgupta-secret' });
    assert.ok(payload, 'the old credentials are still accepted');

    await assert.rejects(
      registrationService.login('cgupta', { password: 'wrong' }),
      /INVALID_PHONE_CREDENTIALS/,
    );
  } finally {
    restore();
  }
});

test('setting an MPIN needs it typed twice, the same both times', () => {
  const ok = resetMpinSchema.validate({ resetToken: 't', mpin: '4517', confirmMpin: '4517' });
  assert.equal(ok.error, undefined);

  const mismatch = resetMpinSchema.validate({ resetToken: 't', mpin: '4517', confirmMpin: '4518' });
  assert.ok(mismatch.error);
  assert.match(mismatch.error.message, /don't match/);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkAvailabilitySchema,
  registerSchema,
  loginSchema,
} = require('../src/validators/auth.validator');

const businessDetails = {
  businessId: '507f1f77bcf86cd799439011',
};

test('live availability validation accepts one complete field at a time', () => {
  assert.equal(
    checkAvailabilitySchema.validate({ mobile: '9876543210', userId: '' }).error,
    undefined,
  );
  assert.equal(
    checkAvailabilitySchema.validate({ mobile: '', userId: 'owner.one' }).error,
    undefined,
  );
});

test('live availability validation rejects empty or malformed fields', () => {
  assert.match(
    checkAvailabilitySchema.validate({ mobile: '', userId: '' }).error.message,
    /Enter a phone number or User ID/i,
  );
  assert.match(
    checkAvailabilitySchema.validate({ mobile: '', userId: 'bad user id' }).error.message,
    /only contain letters/i,
  );
});

test('registration accepts and validates User ID instead of dropping it', () => {
  const valid = registerSchema.validate({
    mobile: '9876543210',
    password: 'secret1',
    userId: 'owner.one',
    businessDetails,
  });
  assert.equal(valid.error, undefined);

  const invalid = registerSchema.validate({
    mobile: '9876543210',
    password: 'secret1',
    userId: 'bad user id',
    businessDetails,
  });
  assert.match(invalid.error.message, /only contain letters/i);
});

test('password rules are bounded consistently during registration', () => {
  const tooShort = registerSchema.validate({
    mobile: '9876543210',
    password: '12345',
    userId: 'owner.one',
    businessDetails,
  });
  assert.match(tooShort.error.message, /at least 6 characters/i);

  const tooLong = registerSchema.validate({
    mobile: '9876543210',
    password: 'x'.repeat(129),
    userId: 'owner.one',
    businessDetails,
  });
  assert.match(tooLong.error.message, /less than or equal to 128 characters/i);
});

test('business login accepts either phone number or chosen User ID', () => {
  assert.equal(
    loginSchema.validate({ mobile: '9876543210', password: 'secret1' }).error,
    undefined,
  );
  assert.equal(
    loginSchema.validate({ mobile: 'owner.one', password: 'secret1' }).error,
    undefined,
  );
});

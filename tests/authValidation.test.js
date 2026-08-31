const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkAvailabilitySchema,
  registerSchema,
  loginSchema,
  requestPasswordResetSchema,
  verifyPasswordResetOtpSchema,
  resetPasswordSchema,
  changePasswordSchema,
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

test('business login takes a User ID; a digit-only ID is just another User ID', () => {
  assert.equal(
    loginSchema.validate({ mobile: 'owner.one', password: 'secret1' }).error,
    undefined,
  );
  // Digits are legal in a User ID, so this is accepted by the schema — but the
  // service resolves it against userId only, never against a phone number.
  assert.equal(
    loginSchema.validate({ mobile: '9876543210', password: 'secret1' }).error,
    undefined,
  );
});

test('business login rejects an identifier too short to be a User ID', () => {
  assert.match(
    loginSchema.validate({ mobile: 'ab', password: 'secret1' }).error.message,
    /at least 3 characters/i,
  );
});

test('password recovery accepts either a registered phone-shaped value or User ID', () => {
  assert.equal(
    requestPasswordResetSchema.validate({ identifier: '9876543210' }).error,
    undefined,
  );
  assert.equal(
    requestPasswordResetSchema.validate({ identifier: 'owner.one' }).error,
    undefined,
  );
  assert.equal(
    verifyPasswordResetOtpSchema.validate({ identifier: 'owner.one', otp: '123456' }).error,
    undefined,
  );
  assert.ok(
    verifyPasswordResetOtpSchema.validate({ identifier: 'owner.one', otp: '123' }).error,
  );
});

test('forgot-password reset requires matching new and confirm passwords', () => {
  assert.equal(
    resetPasswordSchema.validate({
      resetToken: 'signed-reset-token',
      newPassword: 'secret1',
      confirmPassword: 'secret1',
    }).error,
    undefined,
  );

  assert.match(
    resetPasswordSchema.validate({
      resetToken: 'signed-reset-token',
      newPassword: 'secret1',
      confirmPassword: 'different',
    }).error.message,
    /Passwords do not match/i,
  );

  assert.ok(
    resetPasswordSchema.validate({
      resetToken: 'signed-reset-token',
      newPassword: 'secret1',
    }).error,
  );
});

test('normal password change still requires the real current password', () => {
  assert.equal(
    changePasswordSchema.validate({ currentPassword: 'old-secret', newPassword: 'new-secret' }).error,
    undefined,
  );
  assert.ok(
    changePasswordSchema.validate({ currentPassword: '', newPassword: 'new-secret' }).error,
  );
});

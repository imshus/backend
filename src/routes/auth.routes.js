const express = require('express');
const authController = require('../controllers/auth.controller');
const { validate } = require('../middleware/validation.middleware');
const { logGstCheck } = require('../middleware/gstVerificationLog.middleware');
const {
  gstVerifySchema,
  gstConfirmSchema,
  contactDetailsSchema,
  sendOtpSchema,
  verifyMobileOtpSchema,
  verifyOtpSchema,
  checkAvailabilitySchema,
  createPasswordSchema,
  registerSchema,
  loginSchema,
  loginOtpSchema,
  requestPasswordResetSchema,
  verifyPasswordResetOtpSchema,
  resetPasswordSchema,
  revealMpinSchema,
  resetMpinSchema,
  employeeLoginSchema,
  changePasswordSchema,
} = require('../validators/auth.validator');
const {
  gstRateLimiter,
  otpSendLimiter,
  otpVerifyLimiter,
  accountLookupLimiter,
  loginAttemptLimiter,
  accountDeleteOtpLimiter,
  accountDeleteLimiter,
} = require('../middleware/rateLimiter');
const { authenticateJWT, requireCurrentOwner } = require('../middleware/auth.middleware');

const router = express.Router();

// Every sign-up GST check is logged with the name and mobile sent alongside,
// passed or failed (gst_verifications): the account is only created on a
// pass, but a failed attempt is kept too.
router.post('/business/gst/verify', gstRateLimiter, logGstCheck('verify'), validate(gstVerifySchema), authController.verifyGst);
router.post('/check-availability', accountLookupLimiter, validate(checkAvailabilitySchema), authController.checkAvailability);
router.post('/business/gst/confirm', logGstCheck('confirm'), validate(gstConfirmSchema), authController.confirmGst);
router.post('/business/contact-details', validate(contactDetailsSchema), authController.submitContactDetails);
router.post('/register', validate(registerSchema), authController.register);
router.post('/send-otp', otpSendLimiter, validate(sendOtpSchema), authController.sendOtp);
router.post('/verify-otp', otpVerifyLimiter, validate(verifyMobileOtpSchema), authController.verifyOtpByMobile);
router.post('/login-otp', otpVerifyLimiter, validate(loginOtpSchema), authController.loginWithOtp);
// Recovers the User ID registered against a phone number. Same OTP proof as
// login-otp, but returns only the User ID — no session is issued.
router.post('/forgot-user-id', otpVerifyLimiter, validate(loginOtpSchema), authController.recoverUserId);
router.post('/forgot-password/request', accountLookupLimiter, validate(requestPasswordResetSchema), authController.requestPasswordReset);
router.post('/forgot-password/verify-otp', validate(verifyPasswordResetOtpSchema), authController.verifyPasswordResetOtp);
router.post('/forgot-password/reset', validate(resetPasswordSchema), authController.resetForgottenPassword);
// The MPIN behind the same token: a forgotten one, or a first one for an
// account created before MPINs existed.
router.post('/forgot-password/set-mpin', validate(resetMpinSchema), authController.setForgottenMpin);
// The MPIN already on the account, for the Forgot MPIN screen. Same token,
// same ten minutes; null when the account predates the sealed copy.
router.post('/forgot-password/reveal-mpin', otpVerifyLimiter, validate(revealMpinSchema), authController.revealStoredMpin);
router.get('/dev/otps/:businessId', authController.getDevOtps);
router.post('/business/verify-phone-otp', validate(verifyOtpSchema), authController.verifyPhoneOtp);
router.post('/business/create-password', validate(createPasswordSchema), authController.createPassword);
// A 4-digit MPIN is ten thousand guesses, so signing in is no longer an
// endpoint anyone may hammer: attempts are counted per phone number (or User
// ID) rather than per IP, which is what a shop's own connection shares.
router.post('/business/login', loginAttemptLimiter, validate(loginSchema), authController.login);
router.post('/login', loginAttemptLimiter, validate(loginSchema), authController.login);
// The old employee login (phone + password), kept for builds that still use
// it. Counted in the same per-number bucket as the owner login above.
router.post('/employee/login', loginAttemptLimiter, validate(employeeLoginSchema), authController.loginEmployee);
router.get('/employee/permissions', authenticateJWT, authController.getEmployeePermissions);
router.post('/change-password', authenticateJWT, validate(changePasswordSchema), authController.changePassword);
// Settings -> MPIN Manager, for the owner and for an employee alike. Checked
// in the service rather than by a schema, so each refusal carries its own
// code; wrong current MPINs are counted per account there too.
router.post('/change-mpin', authenticateJWT, authController.changeMpin);
router.post('/refresh', authController.refreshToken);
// Deleting one's own account, any role: a code to the account's own phone,
// then that code and the word DELETE. Only the caller's sign-in goes
// (archived in released_logins); the shop and everything in it stay
// (accountRelease.service). An owner's token counts only while their sign-in
// record is still the shop's owner's (not one just made someone's employee).
router.post('/account/delete-otp', authenticateJWT, requireCurrentOwner, accountDeleteOtpLimiter, authController.sendAccountDeleteOtp);
router.delete('/account', authenticateJWT, requireCurrentOwner, accountDeleteLimiter, authController.deleteAccount);

module.exports = router;

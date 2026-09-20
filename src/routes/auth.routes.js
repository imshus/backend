const express = require('express');
const authController = require('../controllers/auth.controller');
const { validate } = require('../middleware/validation.middleware');
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
} = require('../middleware/rateLimiter');
const { authenticateJWT } = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/business/gst/verify', gstRateLimiter, validate(gstVerifySchema), authController.verifyGst);
router.post('/check-availability', accountLookupLimiter, validate(checkAvailabilitySchema), authController.checkAvailability);
router.post('/business/gst/confirm', validate(gstConfirmSchema), authController.confirmGst);
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
router.post('/employee/login', validate(employeeLoginSchema), authController.loginEmployee);
router.get('/employee/permissions', authenticateJWT, authController.getEmployeePermissions);
router.post('/change-password', authenticateJWT, validate(changePasswordSchema), authController.changePassword);
router.post('/refresh', authController.refreshToken);

module.exports = router;

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
  employeeLoginSchema,
  changePasswordSchema,
} = require('../validators/auth.validator');
const { gstRateLimiter } = require('../middleware/rateLimiter');
const { authenticateJWT } = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/business/gst/verify', gstRateLimiter, validate(gstVerifySchema), authController.verifyGst);
router.post('/check-availability', validate(checkAvailabilitySchema), authController.checkAvailability);
router.post('/business/gst/confirm', validate(gstConfirmSchema), authController.confirmGst);
router.post('/business/contact-details', validate(contactDetailsSchema), authController.submitContactDetails);
router.post('/register', validate(registerSchema), authController.register);
router.post('/send-otp', validate(sendOtpSchema), authController.sendOtp);
router.post('/verify-otp', validate(verifyMobileOtpSchema), authController.verifyOtpByMobile);
router.post('/login-otp', validate(loginOtpSchema), authController.loginWithOtp);
router.post('/forgot-password/request', validate(requestPasswordResetSchema), authController.requestPasswordReset);
router.post('/forgot-password/verify-otp', validate(verifyPasswordResetOtpSchema), authController.verifyPasswordResetOtp);
router.post('/forgot-password/reset', validate(resetPasswordSchema), authController.resetForgottenPassword);
router.get('/dev/otps/:businessId', authController.getDevOtps);
router.post('/business/verify-phone-otp', validate(verifyOtpSchema), authController.verifyPhoneOtp);
router.post('/business/create-password', validate(createPasswordSchema), authController.createPassword);
router.post('/business/login', validate(loginSchema), authController.login);
router.post('/login', validate(loginSchema), authController.login);
router.post('/employee/login', validate(employeeLoginSchema), authController.loginEmployee);
router.get('/employee/permissions', authenticateJWT, authController.getEmployeePermissions);
router.post('/change-password', authenticateJWT, validate(changePasswordSchema), authController.changePassword);
router.post('/refresh', authController.refreshToken);

module.exports = router;

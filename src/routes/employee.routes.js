const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employee.controller');
const { authenticateJWT, requireCurrentOwner, requireRole } = require('../middleware/auth.middleware');
const { validateInput } = require('../middleware/validation.middleware');
const {
  employeePhoneCheckLimiter,
  employeeOtpSendLimiter,
  employeeOtpVerifyLimiter,
} = require('../middleware/rateLimiter');
const {
  createEmployeeSchema,
  updateEmployeeSchema,
  employeeMpinSchema,
  checkPhoneSchema,
  employeePhoneOtpSchema,
  verifyEmployeePhoneOtpSchema,
} = require('../validators/employee.validator');

// Only the OWNER manages the roster; an employee may read it and gets just
// their own record back (scoped in the controller). An owner's token counts
// only while their sign-in record is still the shop's owner's (one just made
// an employee keeps a token for up to fifteen minutes).
router.use(authenticateJWT, requireCurrentOwner);

router.get('/', employeeController.getEmployees);
// Before the /:id routes, so "check-phone" is never read as an id.
router.get(
  '/check-phone',
  requireRole('OWNER'),
  employeePhoneCheckLimiter,
  validateInput(checkPhoneSchema, 'query'),
  employeeController.checkPhone,
);
// The employee's number is proved by a code sent to it before it is added
// (or an employee is moved to it); the token the check returns goes back on
// that POST / PUT. Also before the /:id routes.
router.post(
  '/phone-otp',
  requireRole('OWNER'),
  employeeOtpSendLimiter,
  validateInput(employeePhoneOtpSchema),
  employeeController.sendPhoneOtp,
);
router.post(
  '/phone-otp/verify',
  requireRole('OWNER'),
  employeeOtpVerifyLimiter,
  validateInput(verifyEmployeePhoneOtpSchema),
  employeeController.verifyPhoneOtp,
);
router.post('/',requireRole('OWNER'), validateInput(createEmployeeSchema), employeeController.createEmployee);
router.put('/:id/mpin', requireRole('OWNER'), validateInput(employeeMpinSchema), employeeController.setEmployeeMpin);
router.get('/:id/mpin', requireRole('OWNER'), employeeController.getEmployeeMpin);
router.put('/:id', requireRole('OWNER'), validateInput(updateEmployeeSchema), employeeController.updateEmployee);
router.delete('/:id', requireRole('OWNER'), employeeController.deleteEmployee);

module.exports = router;

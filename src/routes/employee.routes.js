const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employee.controller');
const { authenticateJWT, requireRole } = require('../middleware/auth.middleware');
const { validateInput } = require('../middleware/validation.middleware');
const { employeePhoneCheckLimiter } = require('../middleware/rateLimiter');
const {
  createEmployeeSchema,
  updateEmployeeSchema,
  employeeMpinSchema,
  checkPhoneSchema,
} = require('../validators/employee.validator');

// Only the OWNER manages the roster; an employee may read it and gets just
// their own record back (scoped in the controller).
router.use(authenticateJWT);

router.get('/', employeeController.getEmployees);
// Before the /:id routes, so "check-phone" is never read as an id.
router.get(
  '/check-phone',
  requireRole('OWNER'),
  employeePhoneCheckLimiter,
  validateInput(checkPhoneSchema, 'query'),
  employeeController.checkPhone,
);
router.post('/', requireRole('OWNER'), validateInput(createEmployeeSchema), employeeController.createEmployee);
router.put('/:id/mpin', requireRole('OWNER'), validateInput(employeeMpinSchema), employeeController.setEmployeeMpin);
router.get('/:id/mpin', requireRole('OWNER'), employeeController.getEmployeeMpin);
router.put('/:id', requireRole('OWNER'), validateInput(updateEmployeeSchema), employeeController.updateEmployee);
router.delete('/:id', requireRole('OWNER'), employeeController.deleteEmployee);

module.exports = router;

const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employee.controller');
const { authenticateJWT, requireRole } = require('../middleware/auth.middleware');

// Only the OWNER manages the roster; an employee may read it and gets just
// their own record back (scoped in the controller).
router.use(authenticateJWT);

router.get('/', employeeController.getEmployees);
router.post('/', requireRole('OWNER'), employeeController.createEmployee);
router.put('/:id', requireRole('OWNER'), employeeController.updateEmployee);
router.delete('/:id', requireRole('OWNER'), employeeController.deleteEmployee);

module.exports = router;

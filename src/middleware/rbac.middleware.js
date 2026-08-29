const Employee = require('../models/employee.model');

const normalizeRole = (role) => String(role || '').trim().toUpperCase();
const OWNER_EQUIVALENT_ROLES = new Set([
  'OWNER',
  'SUPER',
  'SUPER_ADMIN',
  'SUPERADMIN',
  'SUPER ADMIN'
]);

/**
 * Middleware to enforce Role-Based Access Control
 * @param {String} requiredPermission - The key of the permission required (e.g. 'inventoryManager')
 */
const requirePermission = (requiredPermission) => {
  return async (req, res, next) => {
    try {
      const user = req.user; // Set by requireAuth middleware
      
      if (!user) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const userRole = normalizeRole(user.role);

      // Owner-equivalent users have access to everything
      if (OWNER_EQUIVALENT_ROLES.has(userRole)) {
        return next();
      }

      // If user is EMP, check their permissions in the database
      if (userRole === 'EMP') {
        // Fetch employee to get latest permissions
        const employee = await Employee.findById(user.userId);
        
        if (!employee || !employee.isActive) {
          return res.status(401).json({ success: false, message: 'Employee account deactivated or not found' });
        }

        const hasPermission = employee.permissions && employee.permissions.get(requiredPermission) === true;
        
        if (!hasPermission) {
          return res.status(403).json({ 
            success: false, 
            message: `Forbidden: Requires ${requiredPermission} permission` 
          });
        }

        return next();
      }

      return res.status(403).json({ success: false, message: 'Forbidden: Unknown role' });
    } catch (error) {
      console.error('RBAC Middleware Error:', error);
      res.status(500).json({ success: false, message: 'Server Error verifying permissions' });
    }
  };
};

module.exports = {
  requirePermission
};

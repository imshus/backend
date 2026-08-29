const bcrypt = require('bcryptjs');
const redisClient = require('../redis/redisClient');
const Employee = require('../models/employee.model');
const licenseService = require('../services/license.service');

const createEmployee = async (req, res) => {
  try {
    const { name, phone, email, permissions, password } = req.body;
    const businessId = req.user.businessId; 

    const { licenseStatus } = await licenseService.getLicenseOverview(businessId);
    if (licenseStatus === 'NO_LICENSE') {
      const existingEmployees = await Employee.countDocuments({ businessId });
      if (existingEmployees >= 1) {
        return res.status(403).json({
          success: false,
          error: 'TRIAL_REQUIRED_FOR_MORE_EMPLOYEES',
          message: 'Start your free trial to add more than one employee.',
        });
      }
    }

    // Step 2: Finalize if password is provided
    if (password) {
      const redisKey = `emp_draft:${businessId}`;
      let draftDataStr;
      
      if (redisClient) {
          draftDataStr = await redisClient.get(redisKey);
      }

      let draftData = null;
      if (draftDataStr) {
        draftData = JSON.parse(draftDataStr);
      }

      if (!draftData) {
        if (!name) {
          return res.status(400).json({ success: false, message: 'Draft expired or not found' });
        }
        draftData = {
          businessId: businessId.toString(),
          name,
          phone,
          email,
          permissions: permissions || {},
        };
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      const newEmployee = new Employee({
        businessId,
        name: draftData.name,
        phone: draftData.phone,
        email: draftData.email,
        passwordHash,
        permissions: draftData.permissions
      });

      await newEmployee.save();

      if (redisClient) {
          await redisClient.del(redisKey);
      }

      return res.status(201).json({
        success: true,
        message: 'Employee created successfully',
        data: {
          name: newEmployee.name
        }
      });
    }

    // Step 1: Draft if no password
    if (!name) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }

    const draftData = {
      businessId: businessId.toString(),
      name,
      phone,
      email,
      permissions: permissions || {}
    };

    const redisKey = `emp_draft:${businessId}`;
    if (redisClient) {
        await redisClient.set(redisKey, JSON.stringify(draftData), 'EX', 3600);
    }

    return res.status(200).json({
      success: true,
      message: 'Draft saved successfully'
    });

  } catch (error) {
    console.error('Create Employee Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getEmployees = async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const employees = await Employee.find({ businessId }).select('-passwordHash');

    res.status(200).json({
      success: true,
      data: employees
    });
  } catch (error) {
    console.error('Get Employees Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, permissions, isActive } = req.body;
    const businessId = req.user.businessId;

    const updateData = { name, phone, email, permissions };
    if (typeof isActive === 'boolean') {
      updateData.isActive = isActive;
    }

    const updated = await Employee.findOneAndUpdate(
      { _id: id, businessId },
      updateData,
      { returnDocument: 'after' }
    ).select('-passwordHash');

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Employee updated successfully',
      data: updated
    });
  } catch (error) {
    console.error('Update Employee Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const result = await Employee.deleteOne({ _id: id, businessId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Employee deleted successfully'
    });
  } catch (error) {
    console.error('Delete Employee Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  createEmployee,
  getEmployees,
  updateEmployee,
  deleteEmployee
};

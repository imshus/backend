const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const redisClient = require('../redis/redisClient');
const Employee = require('../models/employee.model');
const licenseService = require('../services/license.service');
const employeeAccounts = require('../services/employeeAccount.service');
const { isOwnerRole } = require('../services/userScope.service');
const { normalizeIndianMobile } = require('../utils/phone');
const { toPlainPermissions } = require('../utils/permissions');

/**
 * The shop's roster. Every write here is the owner's (the routes refuse
 * employees) and scoped to the owner's own business.
 *
 * Adding someone is one request from this build — name, phone, designation,
 * the MPIN the owner sets, and the permissions picked on the next screen —
 * and creates both the Employee document and the employee's sign-in record
 * (business_users, role EMP). A number that is already anyone's, owner or
 * employee, in any shop, is refused before anything is written.
 *
 * Builds 1.0.360/1.0.361 add in two steps (a draft in Redis, then a password)
 * and keep working; the duplicate-number rule applies to them too.
 */

const PHONE_TAKEN = {
  success: false,
  error: 'PHONE_ALREADY_REGISTERED',
  message: 'This number is already registered',
};

const NOT_FOUND = { success: false, error: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found' };

const draftKey = (businessId) => `emp_draft:${businessId}`;

async function readDraft(businessId) {
  if (!redisClient) return null;
  const raw = await redisClient.get(draftKey(businessId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function clearDraft(businessId) {
  if (redisClient) await redisClient.del(draftKey(businessId));
}

/** The body's fields over the draft's: what was sent now wins. */
function overDraft(draft, body) {
  const merged = { ...(draft || {}) };
  for (const key of ['name', 'phone', 'email', 'designation', 'permissions']) {
    if (body[key] !== undefined && body[key] !== null) merged[key] = body[key];
  }
  return merged;
}

/** Permissions as sent, or undefined so the model's defaults apply. */
const permissionsFrom = (value) => (value && typeof value === 'object' ? toPlainPermissions(value) : undefined);

/** This business's employee by id; null for a malformed id or another shop's. */
async function findOwnEmployee(req) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return null;
  return Employee.findOne({ _id: id, businessId: req.user.businessId });
}

/**
 * Writes the Employee document and its sign-in record together. If the
 * sign-in record cannot be written the Employee document goes too, so a
 * refused number leaves nothing behind.
 */
async function createEmployeeWithAccount(fields, { mpin } = {}) {
  const employee = await Employee.create(fields);
  if (!normalizeIndianMobile(employee.phone)) return { employee };
  try {
    await employeeAccounts.createAccountFor(employee, { mpin });
    return { employee };
  } catch (error) {
    await Employee.deleteOne({ _id: employee._id }).catch(() => {});
    if (error.message === 'PHONE_ALREADY_REGISTERED') return { phoneTaken: true };
    throw error;
  }
}

const createEmployee = async (req, res) => {
  try {
    const body = req.validated || req.body || {};
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

    // This build: everything in one request, the MPIN set by the owner.
    if (body.mpin) {
      const phone = normalizeIndianMobile(body.phone);
      if (await employeeAccounts.isPhoneRegistered(phone)) {
        return res.status(409).json(PHONE_TAKEN);
      }

      const { employee, phoneTaken } = await createEmployeeWithAccount({
        businessId,
        name: body.name,
        phone,
        ...(body.email ? { email: body.email } : {}),
        designation: body.designation,
        permissions: permissionsFrom(body.permissions),
      }, { mpin: body.mpin });
      if (phoneTaken) return res.status(409).json(PHONE_TAKEN);

      // A draft an older build left behind is spent: what was sent now stands.
      await clearDraft(businessId);

      return res.status(201).json({
        success: true,
        message: 'Employee created successfully',
        data: { employee: await employeeAccounts.presentEmployee(employee) },
      });
    }

    // Builds 1.0.360/1.0.361, second step: finish the draft with a password.
    if (body.password) {
      const draft = overDraft(await readDraft(businessId), body);
      if (!draft.name) {
        return res.status(400).json({ success: false, message: 'Draft expired or not found' });
      }

      const phone = normalizeIndianMobile(draft.phone);
      if (phone && await employeeAccounts.isPhoneRegistered(phone)) {
        return res.status(409).json(PHONE_TAKEN);
      }

      const passwordHash = await bcrypt.hash(String(body.password), 10);
      const { employee, phoneTaken } = await createEmployeeWithAccount({
        businessId,
        name: draft.name,
        phone: phone || draft.phone,
        ...(draft.email ? { email: draft.email } : {}),
        designation: draft.designation || '',
        passwordHash,
        permissions: permissionsFrom(draft.permissions),
      });
      if (phoneTaken) return res.status(409).json(PHONE_TAKEN);

      await clearDraft(businessId);

      return res.status(201).json({
        success: true,
        message: 'Employee created successfully',
        data: {
          name: employee.name,
          employee: await employeeAccounts.presentEmployee(employee),
        },
      });
    }

    // Builds 1.0.360/1.0.361, first step: keep the details for an hour.
    if (!body.name) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    // Refused here already, so the owner hears about it on the first screen.
    if (body.phone && await employeeAccounts.isPhoneRegistered(body.phone)) {
      return res.status(409).json(PHONE_TAKEN);
    }

    const draftData = {
      businessId: businessId.toString(),
      name: body.name,
      phone: body.phone,
      email: body.email,
      designation: body.designation || '',
      permissions: permissionsFrom(body.permissions) || {},
    };
    if (redisClient) {
      await redisClient.set(draftKey(businessId), JSON.stringify(draftData), 'EX', 3600);
    }

    return res.status(200).json({
      success: true,
      message: 'Draft saved successfully',
    });
  } catch (error) {
    console.error('Create Employee Error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getEmployees = async (req, res) => {
  try {
    const businessId = req.user.businessId;
    // The owner sees the whole roster; an employee sees only themselves.
    const filter = isOwnerRole(req.user.role)
      ? { businessId }
      : { businessId, _id: req.user.userId };
    const employees = await Employee.find(filter).select('-passwordHash');

    res.status(200).json({
      success: true,
      data: await employeeAccounts.presentEmployees(employees),
    });
  } catch (error) {
    console.error('Get Employees Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/** GET /employees/check-phone?phone= — whether a number is free to add. */
const checkPhone = async (req, res) => {
  try {
    const { phone } = req.validated || {};
    const taken = await employeeAccounts.isPhoneRegistered(phone);
    return res.status(200).json({ success: true, data: { available: !taken } });
  } catch (error) {
    console.error('Check Employee Phone Error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

const updateEmployee = async (req, res) => {
  try {
    const body = req.validated || req.body || {};
    const employee = await findOwnEmployee(req);
    if (!employee) return res.status(404).json(NOT_FOUND);

    const account = await employeeAccounts.findAccountOf(employee);
    const previousPhone = employee.phone;
    let phoneChanged = false;

    if (body.phone !== undefined) {
      const nextPhone = normalizeIndianMobile(body.phone);
      if (nextPhone !== normalizeIndianMobile(previousPhone)) {
        // Their own number and their own sign-in record are not a clash.
        const taken = await employeeAccounts.isPhoneRegistered(nextPhone, {
          exceptEmployeeId: employee._id,
          exceptUserId: account?._id,
        });
        if (taken) return res.status(409).json(PHONE_TAKEN);
        phoneChanged = true;
      }
      employee.phone = nextPhone;
    }
    if (body.name !== undefined) employee.name = body.name;
    if (body.email !== undefined) employee.email = body.email || undefined;
    if (body.designation !== undefined) employee.designation = body.designation;
    if (body.permissions !== undefined) employee.permissions = permissionsFrom(body.permissions) || {};
    if (body.isActive !== undefined) employee.isActive = body.isActive;

    await employee.save();

    // The sign-in record follows: number, name, permissions, on or off.
    try {
      await employeeAccounts.syncAccountOf(employee, { account });
    } catch (error) {
      if (error.message !== 'PHONE_ALREADY_REGISTERED') throw error;
      if (phoneChanged) {
        // Lost a race for the number: put the old one back, write nothing.
        employee.phone = previousPhone;
        await employee.save();
        return res.status(409).json(PHONE_TAKEN);
      }
      // An employee from before sign-in records whose unchanged number is
      // already another account's: the edit stands, they just have none.
      console.warn('[Employees] No sign-in record for employee', String(employee._id), '- number in use');
    }

    res.status(200).json({
      success: true,
      message: 'Employee updated successfully',
      data: await employeeAccounts.presentEmployee(employee),
    });
  } catch (error) {
    console.error('Update Employee Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/** PUT /employees/:id/mpin — the owner sets or changes the employee's MPIN. */
const setEmployeeMpin = async (req, res) => {
  try {
    const { mpin } = req.validated || req.body || {};
    const employee = await findOwnEmployee(req);
    if (!employee) return res.status(404).json(NOT_FOUND);

    try {
      await employeeAccounts.setMpinFor(employee, mpin);
    } catch (error) {
      if (error.message === 'PHONE_ALREADY_REGISTERED') return res.status(409).json(PHONE_TAKEN);
      if (error.message === 'EMPLOYEE_PHONE_REQUIRED') {
        return res.status(400).json({
          success: false,
          error: 'EMPLOYEE_PHONE_REQUIRED',
          message: 'Add a mobile number for this employee first.',
        });
      }
      throw error;
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Set Employee MPIN Error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * GET /employees/:id/mpin — the MPIN the owner set, read back from its sealed
 * copy so it can be shown and shared again. Null when none is set (or it was
 * set before the sealed copy existed).
 */
const getEmployeeMpin = async (req, res) => {
  try {
    const employee = await findOwnEmployee(req);
    if (!employee) return res.status(404).json(NOT_FOUND);

    const mpin = await employeeAccounts.readMpinOf(employee);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: { mpin } });
  } catch (error) {
    console.error('Get Employee MPIN Error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

const deleteEmployee = async (req, res) => {
  try {
    const employee = await findOwnEmployee(req);
    if (!employee) return res.status(404).json(NOT_FOUND);

    // The sign-in record first: an employee left without one can still be
    // deleted, but a sign-in record left without its employee would hold the
    // number for nobody.
    await employeeAccounts.removeAccountOf(employee._id);
    await Employee.deleteOne({ _id: employee._id, businessId: req.user.businessId });

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
  checkPhone,
  updateEmployee,
  setEmployeeMpin,
  getEmployeeMpin,
  deleteEmployee
};

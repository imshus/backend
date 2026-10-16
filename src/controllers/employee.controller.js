const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const redisClient = require('../redis/redisClient');
const Employee = require('../models/employee.model');
const licenseService = require('../services/license.service');
const employeeAccounts = require('../services/employeeAccount.service');
const otpService = require('../services/otp.service');
const { isOwnerRole } = require('../services/userScope.service');
const { normalizeIndianMobile, isStoredPhone } = require('../utils/phone');
const { toPlainPermissions } = require('../utils/permissions');
const {
  EMPLOYEE_PHONE_TOKEN_TTL_SECONDS,
  signEmployeePhoneToken,
  isEmployeePhoneVerified,
} = require('../utils/employeePhoneToken');

/**
 * The shop's roster. Every write here is the owner's (the routes refuse
 * employees) and scoped to the owner's own business.
 *
 * Adding someone is one request from this build — name, phone, designation,
 * the MPIN the owner sets, and the permissions picked on the next screen —
 * and creates both the Employee document and the employee's sign-in record
 * (business_users, role EMP). The owner's own number, a SUPER account's and
 * one of this shop's employees are refused before anything is written.
 * Another shop's owner or employee, or a second owner of this shop, is moved
 * here once the number is proved and the app says the owner was shown whose
 * login it is (`confirmTransfer`): their sign-in record is archived whole in
 * released_logins and taken out of business_users (another shop's employee
 * is also switched off there), and put back if the add then fails. Nothing
 * else of theirs — business, invoices, scans, wallet — is touched.
 *
 * The number is the employee's sign-in, so it is proved first: a code is
 * texted to it (POST /phone-otp), the owner types it in (POST
 * /phone-otp/verify), and the token that returns has to come back on the
 * request that adds them, or that moves an existing employee to a new number.
 *
 * Builds 1.0.360/1.0.361 add in two steps (a draft in Redis, then a password).
 * The draft step still works; the finishing step needs the same token, which
 * those builds cannot get, so they are told to update. The duplicate-number
 * rule applies to them as it always did: a number that is anyone's is
 * refused there, never moved.
 */

const PHONE_TAKEN = {
  success: false,
  error: 'PHONE_ALREADY_REGISTERED',
  message: 'This number is already registered',
};

const OWN_NUMBER = {
  success: false,
  error: 'OWN_NUMBER',
  message: "You can't add your own number as an employee.",
};

const PHONE_NOT_VERIFIED = {
  success: false,
  error: 'EMPLOYEE_PHONE_NOT_VERIFIED',
  message: "Verify the employee's phone number with the OTP sent to it. If you don't see an OTP step, update the MRPscan app.",
};

const OTP_SEND_FAILED = {
  success: false,
  error: 'OTP_SEND_FAILED',
  message: "Couldn't send the OTP right now. Please try again.",
};

// What a refused code is called, and what the owner is told.
const OTP_REFUSALS = {
  OTP_INVALID: 'Wrong OTP',
  OTP_EXPIRED: 'OTP expired, send a new one',
  OTP_NOT_FOUND: 'No OTP was sent to this number. Send one first.',
  OTP_ALREADY_USED: 'This OTP was already used, send a new one',
};

const EMPLOYEE_PHONE_FLOW = 'EMPLOYEE_PHONE';
const OTP_TTL_SECONDS = 10 * 60; // as otp.service stores it
const OTP_RESEND_AFTER_SECONDS = 30;

/** Whether the request carries the proof for this shop and this number. */
const phoneVerified = (body, businessId, phone) =>
  isEmployeePhoneVerified(body.phoneVerificationToken, { businessId, phone });

const TRANSFER_UNCONFIRMED = {
  success: false,
  error: 'TRANSFER_CONFIRMATION_REQUIRED',
  message: "This number already signs in to MRPscan. Confirm moving it to your shop. If you don't see that step, update the MRPscan app.",
};

/** The 409 a number is refused with, or null when it may be added (or moved here). */
const refusalOf = (claim) => {
  if (claim.status === 'own') return OWN_NUMBER;
  if (claim.status === 'taken') return PHONE_TAKEN;
  return null;
};

/**
 * The 409 for a number that would be moved here when the request does not
 * say the owner was shown whose login it is (`confirmTransfer: true`). Builds
 * from before that screen never send it, so for them nobody is moved and the
 * number stays refused, as it always was; `transfer` says from whom.
 */
const unconfirmedTransferOf = (claim, body) => (claim.status === 'transfer' && body.confirmTransfer !== true
  ? { ...TRANSFER_UNCONFIRMED, transfer: claim.transfer }
  : null);

/** Who holds the number, asked at this moment for this shop and this owner. */
const claimOf = (req, phone, except = {}) => employeeAccounts.classifyPhone(phone, {
  businessId: req.user.businessId,
  userId: req.user.userId,
  ...except,
});

/**
 * Moves a transferable number off whoever holds it, for a request that has
 * proved it; nothing for a free one. What comes back is what restoreReleased
 * puts back if the write that needed the number fails. Null when another
 * request took the number first (nothing of this one's stays moved): the
 * caller answers 409.
 */
const releaseFor = async (req, claim, phone) => {
  if (claim.status !== 'transfer') return [];
  try {
    return await employeeAccounts.releasePhoneHolders(claim, {
      businessId: req.user.businessId,
      userId: req.user.userId,
      phone,
    });
  } catch (error) {
    if (error.message === 'PHONE_ALREADY_REGISTERED') return null;
    throw error;
  }
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
 * sign-in record cannot be written the Employee document goes too (and a
 * record written before the failure), so a refused number leaves nothing
 * behind and is free again for whoever it was moved from.
 */
async function createEmployeeWithAccount(fields, { mpin } = {}) {
  const employee = await Employee.create(fields);
  if (!normalizeIndianMobile(employee.phone)) return { employee };
  try {
    await employeeAccounts.createAccountFor(employee, { mpin });
    return { employee };
  } catch (error) {
    await employeeAccounts.removeAccountOf(employee._id).catch(() => {});
    await Employee.deleteOne({ _id: employee._id }).catch(() => {});
    if (error.message === 'PHONE_ALREADY_REGISTERED') return { phoneTaken: true };
    throw error;
  }
}

const TRIAL_REQUIRED = {
  success: false,
  error: 'TRIAL_REQUIRED_FOR_MORE_EMPLOYEES',
  message: 'Start your free trial to add more than one employee.',
};

/** Whether the shop's licence lets it add one more employee. */
async function mayAddEmployee(businessId) {
  const { licenseStatus } = await licenseService.getLicenseOverview(businessId);
  if (licenseStatus !== 'NO_LICENSE') return true;
  return (await Employee.countDocuments({ businessId })) < 1;
}

const createEmployee = async (req, res) => {
  try {
    const body = req.validated || req.body || {};
    const businessId = req.user.businessId;

    if (!(await mayAddEmployee(businessId))) return res.status(403).json(TRIAL_REQUIRED);

    // This build: everything in one request, the MPIN set by the owner.
    if (body.mpin) {
      const phone = normalizeIndianMobile(body.phone);
      if (!phoneVerified(body, businessId, phone)) return res.status(403).json(PHONE_NOT_VERIFIED);
      // Asked again now, whatever check-phone or the OTP step said earlier.
      const claim = await claimOf(req, phone);
      const refused = refusalOf(claim) || unconfirmedTransferOf(claim, body);
      if (refused) return res.status(409).json(refused);

      const released = await releaseFor(req, claim, phone);
      if (!released) return res.status(409).json(PHONE_TAKEN);
      let added;
      try {
        added = await createEmployeeWithAccount({
          businessId,
          name: body.name,
          phone,
          ...(body.email ? { email: body.email } : {}),
          designation: body.designation,
          permissions: permissionsFrom(body.permissions),
        }, { mpin: body.mpin });
      } catch (error) {
        await employeeAccounts.restoreReleased(released);
        throw error;
      }
      const { employee, phoneTaken } = added;
      if (phoneTaken) {
        await employeeAccounts.restoreReleased(released);
        return res.status(409).json(PHONE_TAKEN);
      }

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
      // No number, or one never proved: refused like the MPIN path.
      if (!phoneVerified(body, businessId, phone)) return res.status(403).json(PHONE_NOT_VERIFIED);
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

/**
 * GET /employees/check-phone?phone= — whether a number may be added: free,
 * or held by someone who would be moved here (`transfer` says who, an owner
 * or an employee, and whether of this shop). The owner's own number says so.
 */
const checkPhone = async (req, res) => {
  try {
    const { phone } = req.validated || {};
    const claim = await claimOf(req, phone);
    const data = { available: claim.status === 'free' || claim.status === 'transfer' };
    if (claim.transfer) data.transfer = claim.transfer;
    if (claim.status === 'own') data.reason = 'OWN_NUMBER';
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Check Employee Phone Error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * POST /employees/phone-otp — texts a code to the number being added. A
 * number that may not be added is refused exactly as check-phone answers it,
 * before anything is sent; one that would be moved here is texted, and the
 * answer says from whom (`transfer`). Nothing moves until the add itself.
 */
const sendPhoneOtp = async (req, res) => {
  try {
    const { phone, employeeId } = req.validated || {};
    // A shop that cannot add another employee is told before an SMS is paid
    // for, not after the owner has verified, set an MPIN and permissions.
    // A number change for an employee the shop already has is not an add.
    const existing = employeeId
      ? await Employee.exists({ _id: employeeId, businessId: req.user.businessId })
      : null;
    if (!existing && !(await mayAddEmployee(req.user.businessId))) {
      return res.status(403).json(TRIAL_REQUIRED);
    }
    const claim = await claimOf(req, phone, { exceptEmployeeId: existing ? employeeId : null });
    const refused = refusalOf(claim);
    if (refused) return res.status(409).json(refused);

    try {
      await otpService.sendMobileOtp({
        mobile: phone,
        flow: EMPLOYEE_PHONE_FLOW,
        otpType: 'PHONE',
        businessId: req.user.businessId,
        destination: phone,
        route: '/api/v1/employees/phone-otp',
      });
    } catch (error) {
      if (String(error.message).startsWith('MSG91_')) return res.status(502).json(OTP_SEND_FAILED);
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        phone,
        expiresInSeconds: OTP_TTL_SECONDS,
        resendAfterSeconds: OTP_RESEND_AFTER_SECONDS,
        ...(claim.transfer ? { transfer: claim.transfer } : {}),
      },
    });
  } catch (error) {
    console.error('Send Employee Phone OTP Error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * POST /employees/phone-otp/verify — checks the code against the latest one
 * this shop sent to the number (another shop's code never counts), once, and
 * answers with the token the add or the number change carries.
 */
const verifyPhoneOtp = async (req, res) => {
  try {
    const { phone, otp } = req.validated || {};
    const businessId = req.user.businessId;

    try {
      await otpService.verifyOtpByMobile({
        mobile: phone,
        otp,
        flow: EMPLOYEE_PHONE_FLOW,
        businessId,
        rejectAlreadyVerified: true,
        route: '/api/v1/employees/phone-otp/verify',
      });
    } catch (error) {
      const message = OTP_REFUSALS[error.message];
      if (message) return res.status(400).json({ success: false, error: error.message, message });
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        phoneVerificationToken: signEmployeePhoneToken({ businessId, phone }),
        expiresInSeconds: EMPLOYEE_PHONE_TOKEN_TTL_SECONDS,
      },
    });
  } catch (error) {
    console.error('Verify Employee Phone OTP Error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

const updateEmployee = async (req, res) => {
  try {
    const body = req.validated || req.body || {};
    const employee = await findOwnEmployee(req);
    if (!employee) return res.status(404).json(NOT_FOUND);

    const account = await employeeAccounts.findAccountOf(employee);
    // What this request may change, to put back if the number turns out to
    // be someone else's after all.
    const before = {
      phone: employee.phone,
      name: employee.name,
      email: employee.email,
      designation: employee.designation,
      permissions: toPlainPermissions(employee.permissions),
      isActive: employee.isActive,
    };
    // Their own number and their own sign-in record are not a clash.
    const isTaken = (phone) => employeeAccounts.isPhoneRegistered(phone, {
      exceptEmployeeId: employee._id,
      exceptUserId: account?._id,
    });
    // An employee who is off holds no number, so another shop may have been
    // given it since; switching them back on claims it again and is checked
    // exactly like a new number.
    const reactivating = body.isActive === true && employee.isActive === false;
    let phoneChanged = false;

    // Who else holds a new number, asked now (see classifyPhone).
    let claim = null;

    if (body.phone !== undefined) {
      const nextPhone = normalizeIndianMobile(body.phone);
      if (!isStoredPhone(nextPhone, before.phone)) {
        // A new number becomes their sign-in, so it is proved like a new
        // employee's. The same number (however written) needs nothing.
        if (!phoneVerified(body, req.user.businessId, nextPhone)) {
          return res.status(403).json(PHONE_NOT_VERIFIED);
        }
        claim = await claimOf(req, nextPhone, { exceptEmployeeId: employee._id, exceptUserId: account?._id });
        const refused = refusalOf(claim) || unconfirmedTransferOf(claim, body);
        if (refused) return res.status(409).json(refused);
        phoneChanged = true;
      }
      employee.phone = nextPhone;
    }
    if (reactivating && !phoneChanged) {
      const phone = normalizeIndianMobile(employee.phone);
      if (phone && await isTaken(phone)) return res.status(409).json(PHONE_TAKEN);
    }
    if (body.name !== undefined) employee.name = body.name;
    if (body.email !== undefined) employee.email = body.email || undefined;
    if (body.designation !== undefined) employee.designation = body.designation;
    if (body.permissions !== undefined) employee.permissions = permissionsFrom(body.permissions) || {};
    if (body.isActive !== undefined) employee.isActive = body.isActive;

    // A proved number another shop's owner or employee (or a second owner
    // here) holds is moved off them first; if the write below does not go
    // through, they get it back.
    const released = phoneChanged ? await releaseFor(req, claim, employee.phone) : [];
    if (!released) return res.status(409).json(PHONE_TAKEN);

    try {
      await employee.save();
      // The sign-in record follows: number, name, permissions, on or off.
      await employeeAccounts.syncAccountOf(employee, { account });
    } catch (error) {
      if (error.message !== 'PHONE_ALREADY_REGISTERED') {
        if (released.length) {
          // Whatever failed, the number goes back to whoever had it.
          Object.assign(employee, before);
          await employee.save().catch(() => {});
          await employeeAccounts.syncAccountOf(employee, { createIfMissing: false }).catch(() => {});
          await employeeAccounts.restoreReleased(released);
        }
        throw error;
      }
      if (phoneChanged || reactivating) {
        // Lost a race for the number (a new one, or the one being claimed
        // back): everything is put back as it was, so nothing is written,
        // and whoever it was moved from gets it back. This employee lets go
        // of it first: an employee given it back without a sign-in record is
        // only switched on while nobody else holds it.
        Object.assign(employee, before);
        try {
          await employee.save();
        } finally {
          await employeeAccounts.restoreReleased(released);
        }
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
  sendPhoneOtp,
  verifyPhoneOtp,
  updateEmployee,
  setEmployeeMpin,
  getEmployeeMpin,
  deleteEmployee
};

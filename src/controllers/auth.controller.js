const gstService = require('../services/gst.service');
const registrationService = require('../services/registration.service');
const otpService = require('../services/otp.service');
const config = require('../config/env');
const { sendSuccess } = require('../utils/apiResponse');

const verifyGst = async (req, res, next) => {
  try {
    const { gstNumber } = req.body;
    const data = await gstService.verifyGST(gstNumber);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const confirmGst = async (req, res, next) => {
  try {
    const { gstNumber } = req.body;
    const gstData = await gstService.verifyGST(gstNumber);
    const data = await registrationService.confirmGst(gstData);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const submitContactDetails = async (req, res, next) => {
  try {
    const { businessId, phone, referralCode } = req.body;
    console.log(`[auth] contact-details request: businessId=${businessId}, phone=${phone}`);
    const data = await registrationService.submitContactDetails(businessId, phone, referralCode);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const register = async (req, res, next) => {
  try {
    const { mobile, password, mpin, userId, fullName, referralCode, businessDetails } = req.body;
    const data = await registrationService.register({
      mobile,
      password,
      mpin,
      userId,
      fullName,
      referralCode,
      businessDetails,
    });
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

// Signup-form pre-check so uniqueness errors surface on the register page,
// before the OTP is sent — not later on the GST screen.
const checkAvailability = async (req, res, next) => {
  try {
    const BusinessUser = require('../models/businessUser.model');
    const { mobile, userId } = req.body;
    const phone = String(mobile || '').replace(/\D/g, '').slice(-10);
    const normalizedUserId = String(userId || '').trim();

    // A User ID is checked against stored User IDs only. It used to be refused
    // when some account held it as a phone number, because login resolved a
    // 10-digit entry to the phone first; login now matches on userId alone, so
    // that no longer applies and the rule only blocked legitimate choices.
    const [phoneUser, userIdUser] = await Promise.all([
      /^[0-9]{10}$/.test(phone) ? BusinessUser.findOne({ phone }) : null,
      normalizedUserId ? BusinessUser.findOne({ userId: normalizedUserId }) : null,
    ]);

    sendSuccess(res, {
      // An employee's number counts: they sign in through this same screen,
      // and sign-up must not hand their number to a new shop.
      phoneTaken: Boolean(phoneUser),
      userIdTaken: Boolean(userIdUser),
      // Whether that account has an MPIN yet. The login screen reads this to
      // offer "Create MPIN" instead of "Forgot MPIN?" to an account from
      // before MPINs existed — most of the accounts in the database — which
      // has nothing to have forgotten. The document is already loaded here,
      // and this route is already rate-limited per number, so the answer
      // costs nothing new and reveals nothing new.
      //
      // Always true for an employee: their MPIN is the owner's to set, so the
      // app must never send them to create one. It goes on to the code and
      // the MPIN, and a login without one answers EMPLOYEE_MPIN_NOT_SET.
      phoneHasMpin: String(phoneUser?.role || '').toUpperCase() === 'EMP'
        ? true
        : Boolean(phoneUser?.mpinHash),
    });
  } catch (err) {
    next(err);
  }
};

const sendOtp = async (req, res, next) => {
  try {
    const { mobile } = req.body;
    const data = await otpService.sendMobileOtp({
      mobile,
      flow: 'LOGIN',
      route: '/api/v1/auth/send-otp',
    });
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const verifyOtpByMobile = async (req, res, next) => {
  try {
    const { mobile, otp } = req.body;
    const data = await otpService.verifyOtpByMobile({
      mobile,
      otp,
      route: '/api/v1/auth/verify-otp',
    });
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const getDevOtps = async (req, res, next) => {
  try {
    if (config.env !== 'development') {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    const data = otpService.getDevOtps(req.params.businessId);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const verifyPhoneOtp = async (req, res, next) => {
  try {
    const { businessId, otp } = req.body;
    const data = await registrationService.verifyPhoneOtp(businessId, otp);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const createPassword = async (req, res, next) => {
  try {
    const { businessId, password, fullName, referralCode } = req.body;
    const data = await registrationService.createPassword(
      businessId,
      password,
      undefined,
      fullName,
      referralCode,
    );
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const login = async (req, res, next) => {
  try {
    const { mobile, password, mpin } = req.body;
    const data = await registrationService.login(mobile, { password, mpin });
    sendSuccess(res, data);
  } catch (err) {
    // An account that predates the MPIN has nothing wrong with it: the app is
    // told to send this shop through the OTP that sets one, rather than
    // showing them a credential error they cannot act on.
    if (err?.message === 'MPIN_NOT_SET') {
      return res.status(409).json({
        success: false,
        error: 'MPIN_NOT_SET',
        message: 'Set a 4-digit MPIN for this phone number to sign in.',
      });
    }
    next(err);
  }
};

const loginWithOtp = async (req, res, next) => {
  try {
    const { mobile, otp } = req.body;
    const data = await registrationService.loginWithOtp(mobile, otp);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

/** POST /auth/forgot-user-id — returns the User ID for a verified phone. */
const recoverUserId = async (req, res, next) => {
  try {
    const { mobile, otp } = req.body;
    const data = await registrationService.recoverUserId(mobile, otp);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const requestPasswordReset = async (req, res, next) => {
  try {
    const data = await registrationService.requestPasswordReset(req.body.identifier);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const verifyPasswordResetOtp = async (req, res, next) => {
  try {
    const { identifier, otp } = req.body;
    const data = await registrationService.verifyPasswordResetOtp(identifier, otp);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const resetForgottenPassword = async (req, res, next) => {
  try {
    const { resetToken, newPassword } = req.body;
    const data = await registrationService.resetForgottenPassword(resetToken, newPassword);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

/**
 * Sets the MPIN behind the same OTP-backed token the password reset uses —
 * both for an owner who forgot theirs and for one who never had one.
 */
const setForgottenMpin = async (req, res, next) => {
  try {
    const { resetToken, mpin } = req.body;
    const data = await registrationService.resetForgottenPassword(resetToken, undefined, mpin);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

/**
 * Shows the MPIN already on the account, behind the same OTP-backed token.
 * `mpin` comes back null for an account sealed before the vault existed, and
 * the app then offers to set a new one.
 */
const revealStoredMpin = async (req, res, next) => {
  try {
    const data = await registrationService.revealStoredMpin(req.body.resetToken);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const loginEmployee = async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    const data = await registrationService.loginEmployee({ phone }, password);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const getEmployeePermissions = async (req, res, next) => {
  try {
    const { role, userId } = req.user || {};
    if (String(role || '').toUpperCase() !== 'EMP') {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const Employee = require('../models/employee.model');
    const employee = await Employee.findById(userId).select('permissions isActive');
    if (!employee || employee.isActive === false) {
      return res.status(401).json({ success: false, message: 'Employee not found or inactive' });
    }

    const rawPermissions = employee.permissions;
    const permissions = rawPermissions && typeof rawPermissions.get === 'function'
      ? Object.fromEntries(rawPermissions.entries())
      : rawPermissions || {};

    return res.status(200).json({ success: true, data: { permissions } });
  } catch (err) {
    next(err);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const { userId, role } = req.user;
    const { currentPassword, newPassword } = req.body;
    const data = await registrationService.changePassword(userId, role, currentPassword, newPassword);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) {
      throw new Error('UNAUTHORIZED');
    }
    const authService = require('../services/auth.service');
    const data = await authService.refreshTokens(token);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

// What deleting one's own account answers when it is refused, in words the
// app shows as they are. Nothing has been written when any of these is sent.
const ACCOUNT_DELETE_REFUSALS = {
  CONFIRMATION_REQUIRED: { status: 400, message: 'Type DELETE in capital letters to confirm.' },
  OTP_INVALID: { status: 400, message: 'That OTP is not correct.' },
  OTP_EXPIRED: { status: 400, message: 'This OTP has expired. Send a new one.' },
  OTP_NOT_FOUND: { status: 400, message: 'Send an OTP to your phone first.' },
  OTP_ALREADY_USED: { status: 400, message: 'This OTP was already used. Send a new one.' },
  // What the holder can do about it depends on who they are.
  ACCOUNT_PHONE_MISSING: {
    status: 409,
    message: 'There is no usable phone number on this account to send an OTP to. Please reach us through Contact Us.',
    employeeMessage: 'There is no usable phone number on this account to send an OTP to. Ask your shop owner to update your number or remove you.',
  },
  UNAUTHORIZED: { status: 401, message: 'Your session has ended. Please sign in again.' },
};

/** Answers a refused account deletion; false for anything else. */
const refuseAccountDelete = (req, res, error) => {
  const message = String(error?.message || '');
  if (message.startsWith('MSG91_')) {
    res.status(502).json({ success: false, error: 'OTP_SEND_FAILED', message: "Couldn't send the OTP right now. Please try again." });
    return true;
  }
  const refusal = ACCOUNT_DELETE_REFUSALS[message];
  if (!refusal) return false;
  const isEmployee = String(req.user?.role || '').trim().toUpperCase() === 'EMP';
  const words = (isEmployee && refusal.employeeMessage) || refusal.message;
  res.status(refusal.status).json({ success: false, error: message, message: words });
  return true;
};

// POST /auth/account/delete-otp: a code to the caller's own phone.
const sendAccountDeleteOtp = async (req, res, next) => {
  try {
    const accountRelease = require('../services/accountRelease.service');
    const data = await accountRelease.sendDeleteOtp(req.user);
    sendSuccess(res, data);
  } catch (err) {
    if (!refuseAccountDelete(req, res, err)) next(err);
  }
};

// DELETE /auth/account: the caller's own sign-in only; their shop stays.
const deleteAccount = async (req, res, next) => {
  try {
    const accountRelease = require('../services/accountRelease.service');
    const { otp, confirm } = req.body || {};
    const result = await accountRelease.deleteOwnAccount(req.user, { otp, confirm });
    res.status(200).json(result);
  } catch (err) {
    if (!refuseAccountDelete(req, res, err)) next(err);
  }
};

module.exports = {
  checkAvailability,
  verifyGst,
  confirmGst,
  submitContactDetails,
  register,
  sendOtp,
  verifyOtpByMobile,
  loginWithOtp,
  recoverUserId,
  requestPasswordReset,
  verifyPasswordResetOtp,
  resetForgottenPassword,
  setForgottenMpin,
  revealStoredMpin,
  getDevOtps,
  verifyPhoneOtp,
  createPassword,
  login,
  loginEmployee,
  getEmployeePermissions,
  changePassword,
  refreshToken,
  sendAccountDeleteOtp,
  deleteAccount,
};

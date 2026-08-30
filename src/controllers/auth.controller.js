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
    const { businessId, phone } = req.body;
    console.log(`[auth] contact-details request: businessId=${businessId}, phone=${phone}`);
    const data = await registrationService.submitContactDetails(businessId, phone);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const register = async (req, res, next) => {
  try {
    const { mobile, password, userId, businessDetails } = req.body;
    const data = await registrationService.register({ mobile, password, userId, businessDetails });
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
    const phone = String(mobile || '').replace(/D/g, '').slice(-10);
    const normalizedUserId = String(userId || '').trim();

    const [phoneUser, userIdUser] = await Promise.all([
      /^[0-9]{10}$/.test(phone) ? BusinessUser.findOne({ phone }) : null,
      normalizedUserId ? BusinessUser.findOne({ userId: normalizedUserId }) : null,
    ]);

    sendSuccess(res, {
      phoneTaken: Boolean(phoneUser),
      userIdTaken: Boolean(userIdUser),
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
    const { businessId, password } = req.body;
    const data = await registrationService.createPassword(businessId, password);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
};

const login = async (req, res, next) => {
  try {
    const { mobile, password } = req.body;
    const data = await registrationService.login(mobile, password);
    sendSuccess(res, data);
  } catch (err) {
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
    const data = authService.refreshTokens(token);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
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
  getDevOtps,
  verifyPhoneOtp,
  createPassword,
  login,
  loginEmployee,
  getEmployeePermissions,
  changePassword,
  refreshToken,
};

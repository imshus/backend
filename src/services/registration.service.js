const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Business = require('../models/business.model');
const BusinessUser = require('../models/businessUser.model');
const redisClient = require('../redis/redisClient');
const otpService = require('./otp.service');
const otpRepository = require('../repositories/otp.repository');
const authService = require('./auth.service');
const licenseService = require('./license.service');
const walletService = require('./wallet.service');

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function buildLoginPayload(user, business, tokens) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    businessId: user.businessId.toString(),
    userId: user._id.toString(),
    role: user.role,
    businessName: business ? (business.tradeName || business.legalName) : undefined,
    gstNumber: business ? business.gstNumber : undefined,
    businessType: business ? (business.companyType || business.businessType) : undefined,
    address: business ? business.address : undefined,
    phone: user.phone,
  };
}

const confirmGst = async (gstData) => {
  let business = await Business.findOne({ gstNumber: gstData.gstNumber });
  
  if (business) {
    // Multiple accounts may share one GST number: attach the new user to the
    // existing business instead of rejecting an already-registered GSTIN.
    return {
      businessId: business._id.toString(),
      status: business.isRegistered ? 'REGISTERED' : business.registrationStep
    };
  }

  // Create new Business (No User Yet)
  business = await Business.create({
    gstNumber: gstData.gstNumber,
    legalName: gstData.legalName,
    tradeName: gstData.tradeName,
    businessType: gstData.businessType,
    companyType: gstData.companyType,
    gstStatus: gstData.gstStatus,
    address: gstData.address,
    stateCode: gstData.stateCode,
    stateName: gstData.stateName,
    pincode: gstData.pincode,
    registrationStep: 'GST_CONFIRMED',
    isRegistered: false
  });

  return {
    businessId: business._id.toString(),
    status: 'GST_CONFIRMED'
  };
};

const submitContactDetails = async (businessId, phone) => {
  const business = await Business.findById(businessId);
  if (!business) throw new Error('REGISTRATION_SESSION_EXPIRED');

  const normalizedPhone = normalizePhone(phone);
  if (!/^\d{10}$/.test(normalizedPhone)) {
    throw new Error('INVALID_MOBILE_NUMBER');
  }

  // Check if phone is already taken by a fully registered user
  const existingUser = await BusinessUser.findOne({ phone: normalizedPhone });
  if (existingUser) {
    if (existingUser.phone === normalizedPhone) throw new Error('PHONE_ALREADY_EXISTS');
  }

  // Save temp state in Redis
  const tempState = {
    phone: normalizedPhone,
    phoneVerified: false,
  };
  await redisClient.set(`registration:${businessId}`, JSON.stringify(tempState), "EX", 86400); // 24 hours

  business.registrationStep = 'CONTACT_DETAILS_SUBMITTED';
  await business.save();

  // Send mobile OTP
  await otpService.sendPhoneOtp(businessId, normalizedPhone);

  return {
    phoneOtpSent: true,
  };
};

const verifyPhoneOtp = async (businessId, otp) => {
  await otpService.verifyOtp(businessId, 'PHONE', otp);
  
  const stateStr = await redisClient.get(`registration:${businessId}`);
  if (!stateStr) throw new Error('Session expired');
  
  const state = JSON.parse(stateStr);
  state.phoneVerified = true;
  await redisClient.set(`registration:${businessId}`, JSON.stringify(state), "EX", 86400);

  await Business.findByIdAndUpdate(businessId, { registrationStep: 'PHONE_VERIFIED' });

  return { phoneVerified: true };
};

const createPassword = async (businessId, password) => {
  const stateStr = await redisClient.get(`registration:${businessId}`);
  if (!stateStr) throw new Error('Session expired or incomplete registration');
  
  const state = JSON.parse(stateStr);
  if (!state.phoneVerified) {
     throw new Error('Please verify mobile number first');
  }

  const business = await Business.findById(businessId);
  if (!business) throw new Error('Business not found');

  const passwordHash = await bcrypt.hash(password, 10);

  // Transactions removed because free-tier M0 clusters have limitations with them

  try {
    const newUsers = await BusinessUser.create([{
      businessId: business._id,
      phone: state.phone,
      passwordHash,
      role: 'OWNER',
      phoneVerified: true,
      isActive: true
    }]);

    business.registrationStep = 'PASSWORD_CREATED';
    business.isRegistered = true;
    await business.save();

    await licenseService.ensureLicense(business._id);
    await walletService.ensureWallet(business._id);

    // await session.commitTransaction();
    // session.endSession();

    // Clean up redis
    await redisClient.del(`registration:${businessId}`);

    return {
      registrationCompleted: true,
      userId: newUsers[0]._id.toString()
    };
  } catch (error) {
    // await session.abortTransaction();
    // session.endSession();
    throw error;
  }
};

const login = async (mobile, password) => {
  const normalizedPhone = normalizePhone(mobile);
  const user = await BusinessUser.findOne({ phone: normalizedPhone });
  if (!user || !user.isActive) {
    throw new Error('INVALID_PHONE_CREDENTIALS');
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    throw new Error('INVALID_PHONE_CREDENTIALS');
  }

  user.lastLoginAt = new Date();
  await user.save();

  const tokens = authService.generateTokens(user.businessId.toString(), user._id.toString(), user.role);
  const business = await Business.findById(user.businessId);

  return buildLoginPayload(user, business, tokens);
};

const loginWithOtp = async (mobile, otp) => {
  await otpService.verifyOtpByMobile({
    mobile,
    otp,
    route: '/api/v1/auth/login-otp',
  });

  const normalizedPhone = normalizePhone(mobile);
  const user = await BusinessUser.findOne({ phone: normalizedPhone });
  if (!user || !user.isActive) {
    throw new Error('INVALID_PHONE_CREDENTIALS');
  }

  user.lastLoginAt = new Date();
  await user.save();

  const tokens = authService.generateTokens(user.businessId.toString(), user._id.toString(), user.role);
  const business = await Business.findById(user.businessId);

  return buildLoginPayload(user, business, tokens);
};

const register = async ({ mobile, password, businessDetails }) => {
  const businessId = businessDetails?.businessId;
  if (!businessId) {
    throw new Error('REGISTRATION_SESSION_EXPIRED');
  }

  const normalizedPhone = normalizePhone(mobile);
  const stateStr = await redisClient.get(`registration:${businessId}`);
  let state = stateStr ? JSON.parse(stateStr) : null;

  // The redis key is per-business and several users may register under the
  // same GST number — ignore state left behind by a different phone.
  if (state && normalizePhone(state.phone) !== normalizedPhone) {
    state = null;
  }

  if (!state || !state.phoneVerified) {
    // Signup form verifies the phone OTP before GST (via /auth/send-otp +
    // /auth/verify-otp, which are not bound to a businessId). Accept that
    // verification here, applying the same uniqueness check as
    // submitContactDetails.
    const latestOtp = await otpRepository.findLatestByMobile(normalizedPhone);
    if (latestOtp && latestOtp.verified) {
      const existingUser = await BusinessUser.findOne({ phone: normalizedPhone });
      if (existingUser) throw new Error('PHONE_ALREADY_EXISTS');
      state = { phone: normalizedPhone, phoneVerified: true };
      await redisClient.set(`registration:${businessId}`, JSON.stringify(state), 'EX', 86400);
    }
  }

  if (!state || !state.phoneVerified) {
    throw new Error('Please verify mobile number first');
  }

  if (normalizePhone(state.phone) !== normalizedPhone) {
    throw new Error('INVALID_MOBILE_NUMBER');
  }

  if (businessDetails.businessName) {
    await Business.findByIdAndUpdate(businessId, {
      tradeName: businessDetails.businessName,
    });
  }

  return createPassword(businessId, password);
};

const loginEmployee = async ({ phone }, password) => {
  const Employee = require('../models/employee.model');
  const normalizedPhone = phone ? String(phone).replace(/\D/g, '').slice(-10) : null;

  const query = normalizedPhone ? { phone: normalizedPhone } : null;

  if (!query) {
    throw new Error('INVALID_EMPLOYEE_CREDENTIALS');
  }

  const user = await Employee.findOne(query);
  if (!user || !user.isActive) {
    throw new Error('INVALID_EMPLOYEE_CREDENTIALS');
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    throw new Error('INVALID_EMPLOYEE_CREDENTIALS');
  }

  user.lastLoginAt = new Date();
  await user.save();

  const tokens = authService.generateTokens(user.businessId.toString(), user._id.toString(), 'EMP');

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    businessId: user.businessId.toString(),
    userId: user._id.toString(),
    role: 'EMP',
    permissions: user.permissions
  };
};

const changePassword = async (userId, role, currentPassword, newPassword) => {
  let user;
  if (role === 'EMP') {
    const Employee = require('../models/employee.model');
    user = await Employee.findById(userId);
  } else {
    user = await BusinessUser.findById(userId);
  }

  if (!user || !user.isActive) {
    throw new Error('USER_NOT_FOUND');
  }

  const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isMatch) {
    throw new Error('INCORRECT_CURRENT_PASSWORD');
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await user.save();

  return { success: true, message: 'Password updated successfully' };
};

module.exports = {
  confirmGst,
  submitContactDetails,
  register,
  verifyPhoneOtp,
  createPassword,
  login,
  loginWithOtp,
  loginEmployee,
  changePassword,
};

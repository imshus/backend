const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { createHash, randomBytes } = require('crypto');
const Business = require('../models/business.model');
const BusinessUser = require('../models/businessUser.model');
const redisClient = require('../redis/redisClient');
const otpService = require('./otp.service');
const otpRepository = require('../repositories/otp.repository');
const authService = require('./auth.service');
const licenseService = require('./license.service');
const walletService = require('./wallet.service');
const referralService = require('./referral.service');
const { sealMpin, openMpin } = require('../utils/mpinVault');

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

/**
 * Accounts created before the user record carried GST details have no address
 * or gstNumber. Copy them across from the business on first sight so existing
 * users heal without a migration run.
 */
async function backfillUserGstDetails(user, business) {
  if (!user || !business) return;
  const update = {};
  if (!user.address && business.address) update.address = business.address;
  if (!user.gstNumber && business.gstNumber) update.gstNumber = business.gstNumber;
  const resolvedName = business.tradeName || business.legalName;
  if (!user.businessName && resolvedName) update.businessName = resolvedName;
  if (!Object.keys(update).length) return;

  try {
    await BusinessUser.updateOne({ _id: user._id }, { $set: update });
    Object.assign(user, update);
  } catch (error) {
    console.warn('[Auth] Could not backfill user GST details:', error.message);
  }
}

function buildLoginPayload(user, business, tokens) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    businessId: user.businessId.toString(),
    // NOTE: `userId` here is the Mongo _id, used to resolve the account.
    // `loginId` is the handle the user actually signs in with — they are
    // different values and the names unfortunately collide.
    userId: user._id.toString(),
    loginId: user.userId || '',
    fullName: user.fullName || '',
    role: user.role,
    businessName: business ? (business.tradeName || business.legalName) : undefined,
    gstNumber: business ? business.gstNumber : undefined,
    businessType: business ? (business.companyType || business.businessType) : undefined,
    address: business ? business.address : undefined,
    phone: user.phone,
  };
}

function buildBusinessUserQuery(identifier) {
  const raw = String(identifier || '').trim();
  const digits = raw.replace(/\D/g, '');
  const isPhone = /^[+\d\s()-]+$/.test(raw) && digits.length === 10;
  return isPhone ? { phone: digits } : { userId: raw };
}

function maskPhone(phone) {
  const normalized = normalizePhone(phone);
  return normalized.length === 10
    ? `${normalized.slice(0, 2)}******${normalized.slice(-2)}`
    : 'your registered phone';
}

function hashResetNonce(nonce) {
  return createHash('sha256').update(nonce).digest('hex');
}

const confirmGst = async (gstData) => {
  // A GSTIN covers a taxpayer, not a shop: a group trading under one number
  // may run several counters, and each is its own shop here. A business that
  // has finished registering is therefore never joined — doing so would hand
  // whoever knows a public GSTIN that shop's rates, invoices and licence.
  //
  // The shell left behind by an unfinished registration IS picked up again, so
  // retrying the GST step does not leave abandoned businesses behind.
  let business = await Business.findOne({
    gstNumber: gstData.gstNumber,
    isRegistered: { $ne: true },
  });
  
  if (business) {
    // Refresh the stored details from this lookup so a record captured while
    // the server ran in mock mode (e.g. "Dev Mode Address, India") is replaced
    // by the real GSTN address. Stub responses never overwrite real data.
    if (!gstData.isMock) {
      const refreshed = {};
      if (gstData.legalName) refreshed.legalName = gstData.legalName;
      if (gstData.tradeName) refreshed.tradeName = gstData.tradeName;
      if (gstData.address && gstData.address !== 'N/A') refreshed.address = gstData.address;
      if (gstData.businessType) refreshed.businessType = gstData.businessType;
      if (gstData.companyType) refreshed.companyType = gstData.companyType;
      if (gstData.gstStatus) refreshed.gstStatus = gstData.gstStatus;
      if (gstData.stateCode) refreshed.stateCode = gstData.stateCode;
      if (gstData.stateName) refreshed.stateName = gstData.stateName;
      if (gstData.pincode) refreshed.pincode = gstData.pincode;

      if (Object.keys(refreshed).length) {
        await Business.updateOne({ _id: business._id }, { $set: refreshed });

        // Users hold a copy of the address, so refresh theirs too rather than
        // leaving a stale (or dev-mode) value behind on the user record.
        const userUpdate = {};
        if (refreshed.address) userUpdate.address = refreshed.address;
        if (gstData.gstNumber) userUpdate.gstNumber = gstData.gstNumber;
        const freshName = refreshed.tradeName || refreshed.legalName;
        if (freshName) userUpdate.businessName = freshName;
        if (Object.keys(userUpdate).length) {
          await BusinessUser.updateMany({ businessId: business._id }, { $set: userUpdate });
        }
      }
    }

    // Only ever an unfinished registration, so there is no REGISTERED case to
    // report here: a registered shop under this GSTIN was left alone above and
    // a new business is created below.
    return {
      businessId: business._id.toString(),
      status: business.registrationStep
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

const submitContactDetails = async (businessId, phone, referralCode) => {
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

  // The referral is NOT recorded here. This endpoint needs no authentication
  // and takes the businessId from the body, so anyone could name themselves
  // the referrer of a shop that has not registered yet. The code travels with
  // the request that completes the registration instead, where the phone has
  // been proved. A code sent here is only validated, so a typo is still
  // reported while the form is in front of the person.
  if (referralCode) {
    await referralService.resolveReferralCode({ businessId, code: referralCode });
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

/**
 * Hashes whichever credential the caller is setting. An MPIN is four digits,
 * so it is hashed at the same cost as a password was — the work factor is what
 * makes four digits survivable at rest.
 */
const hashCredentials = async ({ password, mpin }) => ({
  ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
  ...(mpin ? { mpinHash: await bcrypt.hash(mpin, 10) } : {}),
});

const createPassword = async (businessId, password, userId, fullName, referralCode, mpin) => {
  const stateStr = await redisClient.get(`registration:${businessId}`);
  if (!stateStr) throw new Error('Session expired or incomplete registration');
  
  const state = JSON.parse(stateStr);
  if (!state.phoneVerified) {
     throw new Error('Please verify mobile number first');
  }

  const business = await Business.findById(businessId);
  if (!business) throw new Error('Business not found');

  // Checked before the account exists, so a mistyped code fails the call
  // instead of leaving a registered shop with a referral it cannot add later.
  const referrer = await referralService.resolveReferralCode({ businessId, code: referralCode });

  // One of the two is always present: the validator refuses a registration
  // with neither. A build that sends a password still gets a passwordHash;
  // this build sends an MPIN and gets an mpinHash.
  const credentials = await hashCredentials({ password, mpin });
  // The column is required, so an MPIN-only account stores a hash of the MPIN
  // there as well until the column can be dropped.
  const passwordHash = credentials.passwordHash || credentials.mpinHash;

  // Transactions removed because free-tier M0 clusters have limitations with them

  try {
    const newUsers = await BusinessUser.create([{
      businessId: business._id,
      phone: state.phone,
      ...(userId ? { userId } : {}),
      fullName: String(fullName || '').trim(),
      ...(credentials.mpinHash ? { mpinHash: credentials.mpinHash } : {}),
      // Sealed beside the hash so Forgot MPIN can show it back after an OTP.
      ...(mpin ? { mpinVault: sealMpin(mpin) } : {}),
      address: business.address || '',
      gstNumber: business.gstNumber || '',
      businessName: business.tradeName || business.legalName || '',
      passwordHash,
      role: 'OWNER',
      phoneVerified: true,
      isActive: true
    }]);

    business.registrationStep = 'PASSWORD_CREATED';
    business.isRegistered = true;
    await business.save();

    // This caller now owns the shop, so their word on who referred it stands.
    if (referrer) {
      await referralService.linkReferral({ businessId, referrer });
    }

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
    // Availability checks improve feedback, but the unique indexes remain the
    // final authority if two registrations race. Convert Mongo's duplicate-key
    // error into the same field-specific codes used by the pre-check.
    if (error?.code === 11000) {
      const duplicateField = Object.keys(error.keyPattern || error.keyValue || {})[0];
      if (duplicateField === 'userId') throw new Error('USER_ID_ALREADY_EXISTS');
      if (duplicateField === 'phone') throw new Error('PHONE_ALREADY_EXISTS');
    }
    throw error;
  }
};

/**
 * Signs an owner in.
 *
 * The identifier is a phone number now — ten digits, which is what the app
 * asks for — and the credential is a 4-digit MPIN. A User ID and password are
 * still accepted so a build already on someone's phone keeps working; that
 * path resolves the User ID exactly, so one that looks like a phone number
 * still belongs to its owner rather than to whoever holds that number.
 *
 * An account with no MPIN yet (every account created before this) is not
 * refused as if the credential were wrong: it is told to set one, which the
 * app does over the same OTP as a forgotten MPIN.
 */
const login = async (mobile, credential) => {
  const { mpin, password } = typeof credential === 'string'
    ? { password: credential }
    : (credential || {});

  const identifier = String(mobile || '').trim();
  const asPhone = identifier.replace(/\D/g, '').slice(-10);
  const user = /^[0-9]{10}$/.test(asPhone)
    ? await BusinessUser.findOne({ phone: asPhone })
    : await BusinessUser.findOne({ userId: identifier });

  if (!user || !user.isActive) {
    throw new Error('INVALID_PHONE_CREDENTIALS');
  }

  if (mpin) {
    if (!user.mpinHash) {
      // Distinguishable on purpose: the app turns this into "set your MPIN",
      // not "wrong MPIN".
      throw new Error('MPIN_NOT_SET');
    }
    if (!await bcrypt.compare(mpin, user.mpinHash)) {
      throw new Error('INVALID_PHONE_CREDENTIALS');
    }
  } else {
    if (!await bcrypt.compare(String(password || ''), user.passwordHash)) {
      throw new Error('INVALID_PHONE_CREDENTIALS');
    }
  }

  user.lastLoginAt = new Date();
  await user.save();

  const tokens = authService.generateTokens(user.businessId.toString(), user._id.toString(), user.role);
  const business = await Business.findById(user.businessId);
  await backfillUserGstDetails(user, business);

  return buildLoginPayload(user, business, tokens);
};

/**
 * Looks up the User ID registered against a phone number, for the
 * "Forgot User ID" flow.
 *
 * The OTP is verified first: without it, anyone could enumerate User IDs from
 * phone numbers and would hold half of someone's login credentials. Unlike
 * loginWithOtp this issues no tokens — recovering a username should not hand
 * out a session.
 */
const recoverUserId = async (mobile, otp) => {
  await otpService.verifyOtpByMobile({
    mobile,
    otp,
    route: '/api/v1/auth/forgot-user-id',
    rejectAlreadyVerified: true,
  });

  const normalizedPhone = normalizePhone(mobile);
  const user = await BusinessUser.findOne({ phone: normalizedPhone });
  if (!user || !user.isActive) {
    throw new Error('INVALID_PHONE_CREDENTIALS');
  }

  if (!user.userId) {
    throw new Error('NO_USER_ID_SET');
  }

  return { userId: user.userId };
};

const loginWithOtp = async (mobile, otp) => {
  // One OTP, one session: a code that already signed someone in is spent.
  await otpService.verifyOtpByMobile({
    mobile,
    otp,
    route: '/api/v1/auth/login-otp',
    rejectAlreadyVerified: true,
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
  await backfillUserGstDetails(user, business);

  return buildLoginPayload(user, business, tokens);
};

const requestPasswordReset = async (identifier) => {
  const user = await BusinessUser.findOne(buildBusinessUserQuery(identifier));
  if (!user || !user.isActive) {
    throw new Error('ACCOUNT_NOT_FOUND');
  }

  await otpService.sendMobileOtp({
    mobile: user.phone,
    flow: 'PASSWORD_RESET',
    businessId: user.businessId,
    route: '/api/v1/auth/forgot-password/request',
  });

  return {
    destination: maskPhone(user.phone),
    message: 'Password reset code sent successfully',
  };
};

const verifyPasswordResetOtp = async (identifier, otp) => {
  const user = await BusinessUser.findOne(buildBusinessUserQuery(identifier));
  if (!user || !user.isActive) {
    throw new Error('ACCOUNT_NOT_FOUND');
  }

  await otpService.verifyOtpByMobile({
    mobile: user.phone,
    otp,
    flow: 'PASSWORD_RESET',
    rejectAlreadyVerified: true,
    route: '/api/v1/auth/forgot-password/verify-otp',
  });

  const nonce = randomBytes(32).toString('hex');
  user.passwordResetNonceHash = hashResetNonce(nonce);
  user.passwordResetExpiresAt = new Date(Date.now() + (10 * 60 * 1000));
  await user.save();

  return {
    resetToken: authService.generatePasswordResetToken(
      user.businessId.toString(),
      user._id.toString(),
      nonce,
    ),
    expiresInSeconds: 600,
  };
};

const resetForgottenPassword = async (resetToken, newPassword, newMpin) => {
  const payload = authService.verifyPasswordResetToken(resetToken);
  const user = await BusinessUser.findById(payload.userId)
    .select('+passwordResetNonceHash +passwordResetExpiresAt');

  const storedNonceHash = user?.passwordResetNonceHash;
  const resetExpiresAt = user?.passwordResetExpiresAt
    ? new Date(user.passwordResetExpiresAt).getTime()
    : 0;
  if (
    !user
    || !user.isActive
    || !storedNonceHash
    || storedNonceHash !== hashResetNonce(payload.nonce)
    || resetExpiresAt <= Date.now()
  ) {
    throw new Error('INVALID_RESET_TOKEN');
  }

  // The same OTP-backed token sets either credential. This is also how an
  // account that predates the MPIN gets one: it has nothing to "reset", so the
  // app sends it here to set one for the first time.
  if (newMpin) {
    user.mpinHash = await bcrypt.hash(newMpin, 10);
    // The column is required and still holds the old password's hash; point it
    // at the MPIN too, so the credential someone knows is the only one that
    // opens the account.
    user.passwordHash = user.mpinHash;
    // Kept in step with the hash, so a later Forgot MPIN shows the MPIN that
    // is actually in force rather than a stale one.
    user.mpinVault = sealMpin(newMpin);
  } else {
    user.passwordHash = await bcrypt.hash(newPassword, 10);
  }
  user.passwordResetNonceHash = undefined;
  user.passwordResetExpiresAt = undefined;
  await user.save();

  return {
    success: true,
    message: newMpin ? 'MPIN set successfully' : 'Password reset successfully',
  };
};

/**
 * The MPIN behind a reset token, for the Forgot MPIN screen.
 *
 * Guarded exactly as the reset itself is: the token has to verify, its nonce
 * has to match the one written when the OTP was accepted, and that nonce has
 * to be inside its ten minutes. The nonce is deliberately NOT consumed — an
 * account sealed before the vault existed has nothing to show, and the same
 * token is what lets the shop set a new MPIN instead.
 */
const revealStoredMpin = async (resetToken) => {
  const payload = authService.verifyPasswordResetToken(resetToken);
  const user = await BusinessUser.findById(payload.userId)
    .select('+passwordResetNonceHash +passwordResetExpiresAt +mpinVault');

  const storedNonceHash = user?.passwordResetNonceHash;
  const resetExpiresAt = user?.passwordResetExpiresAt
    ? new Date(user.passwordResetExpiresAt).getTime()
    : 0;
  if (
    !user
    || !user.isActive
    || !storedNonceHash
    || storedNonceHash !== hashResetNonce(payload.nonce)
    || resetExpiresAt <= Date.now()
  ) {
    throw new Error('INVALID_RESET_TOKEN');
  }

  // Null means "this account predates the sealed copy", which the app reads
  // as "ask them to set a new one" rather than as an error.
  return { mpin: openMpin(user.mpinVault) };
};

const register = async ({ mobile, password, mpin, userId, fullName, referralCode, businessDetails }) => {
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

  // The first registrant names the shop; a later account joining an already
  // registered business does not rename it from an unauthenticated form.
  if (businessDetails.businessName) {
    await Business.updateOne(
      { _id: businessId, isRegistered: { $ne: true } },
      { $set: { tradeName: businessDetails.businessName } },
    );
  }

  const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';
  if (normalizedUserId) {
    const existingUserId = await BusinessUser.findOne({ userId: normalizedUserId });
    if (existingUserId) throw new Error('USER_ID_ALREADY_EXISTS');
  }

  return createPassword(
    businessId,
    password,
    normalizedUserId || undefined,
    fullName,
    referralCode,
    mpin,
  );
};

const loginEmployee = async ({ phone }, password) => {
  const Employee = require('../models/employee.model');
  const normalizedPhone = phone ? String(phone).replace(/\D/g, '').slice(-10) : null;

  const query = normalizedPhone ? { phone: normalizedPhone } : null;

  if (!query) {
    throw new Error('INVALID_EMPLOYEE_CREDENTIALS');
  }

  // Employee phones are not unique across shops (the field carries no unique
  // index), so the password decides which record is meant rather than
  // whichever the database returns first.
  const candidates = await Employee.find({ ...query, isActive: true });
  let user = null;
  for (const candidate of candidates) {
    if (await bcrypt.compare(password, candidate.passwordHash)) {
      user = candidate;
      break;
    }
  }
  if (!user) {
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
  recoverUserId,
  requestPasswordReset,
  verifyPasswordResetOtp,
  resetForgottenPassword,
  revealStoredMpin,
  loginEmployee,
  changePassword,
};

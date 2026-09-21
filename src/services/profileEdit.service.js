const bcrypt = require('bcryptjs');
const { sealMpin } = require('../utils/mpinVault');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const config = require('../config/env');
const Business = require('../models/business.model');
const BusinessUser = require('../models/businessUser.model');
const OrganizationLicense = require('../models/organizationLicense.model');
const otpService = require('./otp.service');
const gstService = require('./gst.service');

/**
 * Changing the two things a shop is identified by: its phone number and its
 * GSTIN.
 *
 * Both are more than profile text. The phone number is what the licence is
 * found on and what signs the owner in; the GSTIN is what the business name
 * and address come from, and what goes on an invoice. So neither is taken on
 * trust here:
 *
 *  - the MPIN is asked for again first, because a phone left on a counter is
 *    an unlocked app, and whoever holds it could otherwise move the account to
 *    their own number;
 *  - a new number is proved with an OTP sent to it, so a typo cannot lock the
 *    shop out of its own account;
 *  - a new GSTIN is looked up at the GST registry, and what comes back is what
 *    is saved — the shop does not get to type its own registered name.
 */

const EDIT_TOKEN_TTL = '10m';
const EDIT_TOKEN_PURPOSE = 'PROFILE_EDIT';
const PHONE_CHANGE_FLOW = 'PROFILE_PHONE_CHANGE';

const tenDigits = (value) => String(value || '').replace(/\D/g, '').slice(-10);

/**
 * Proof that the MPIN was entered, minutes ago, by this user on this account.
 *
 * A token rather than the MPIN itself: the rest of the flow is two or three
 * more requests, and sending the secret with each of them only widens where
 * it can be logged or kept.
 */
const startProfileEdit = async ({ businessId, userId }, mpin) => {
  // Projection as an argument, not a chained .select(): the same query, and
  // it does not assume a query object where the test fakes return a promise.
  const user = await BusinessUser.findById(userId, '+mpinVault');
  if (!user || !user.isActive) throw new Error('UNAUTHORIZED');
  if (!user.mpinHash) throw new Error('MPIN_NOT_SET');
  if (!(await bcrypt.compare(String(mpin || ''), user.mpinHash))) {
    throw new Error('INVALID_MPIN');
  }
  // The other moment the MPIN is in plain text and just proved right: an
  // account from before the readable copy existed gets one here too.
  if (!user.mpinVault) {
    user.mpinVault = sealMpin(String(mpin));
    await user.save();
  }

  const editToken = jwt.sign(
    { businessId: String(businessId), userId: String(userId), nonce: randomUUID(), purpose: EDIT_TOKEN_PURPOSE },
    config.jwt.accessSecret,
    { expiresIn: EDIT_TOKEN_TTL },
  );
  console.info('[PROFILE_EDIT_STARTED]', { phone: user.phone, businessId: String(businessId) });
  return { editToken };
};

/** The token's payload, or a refusal. Bound to the caller's own session. */
const requireEditToken = (editToken, { businessId, userId }) => {
  let payload;
  try {
    payload = jwt.verify(String(editToken || ''), config.jwt.accessSecret);
  } catch (error) {
    throw new Error(error.name === 'TokenExpiredError' ? 'EDIT_SESSION_EXPIRED' : 'EDIT_SESSION_INVALID');
  }
  if (payload.purpose !== EDIT_TOKEN_PURPOSE) throw new Error('EDIT_SESSION_INVALID');
  // A token minted for one account can never edit another, whatever else the
  // request says.
  if (String(payload.userId) !== String(userId) || String(payload.businessId) !== String(businessId)) {
    throw new Error('EDIT_SESSION_INVALID');
  }
  return payload;
};

/**
 * The OTP that guards every change, and where it goes.
 *
 * Every save needs one — the shop asked for it, and it turns an unlocked
 * phone on a counter back into something only the owner can move. A new
 * number gets the code itself, which is what proves it is the shop's own;
 * any other change sends it to the number already on the account. Phones are
 * unique across accounts, so a number already in use is refused here rather
 * than as a database error on save.
 */
const sendProfileChangeOtp = async (session, { editToken, phone }) => {
  requireEditToken(editToken, session);

  const user = await BusinessUser.findById(session.userId).select('phone');
  if (!user) throw new Error('UNAUTHORIZED');
  const current = tenDigits(user.phone);

  const next = phone === undefined || phone === null || String(phone).trim() === ''
    ? current
    : tenDigits(phone);
  const changingNumber = next !== current;

  if (changingNumber) {
    if (!/^[6-9][0-9]{9}$/.test(next)) throw new Error('INVALID_PHONE_NUMBER');
    const taken = await BusinessUser.findOne({ phone: next }).select('_id').lean();
    if (taken) throw new Error('PHONE_ALREADY_REGISTERED');
  } else if (!/^[6-9][0-9]{9}$/.test(current)) {
    throw new Error('INVALID_PHONE_NUMBER');
  }

  await otpService.sendMobileOtp({
    mobile: next,
    flow: PHONE_CHANGE_FLOW,
    businessId: session.businessId,
    route: '/api/v1/settings/business-profile/phone-otp',
  });
  return { phone: next, changingNumber };
};

/** The registry's answer for a GSTIN the shop wants to move to. */
const previewGstChange = async (session, { editToken, gstNumber }) => {
  requireEditToken(editToken, session);

  const gstin = String(gstNumber || '').trim().toUpperCase();
  const business = await Business.findById(session.businessId).select('gstNumber').lean();
  if (business && String(business.gstNumber || '').toUpperCase() === gstin) {
    throw new Error('GST_UNCHANGED');
  }

  const details = await gstService.verifyGST(gstin);
  return {
    gstNumber: details.gstNumber || gstin,
    businessName: details.tradeName || details.legalName || '',
    address: details.address || '',
    gstStatus: details.gstStatus || '',
    isMock: Boolean(details.isMock),
  };
};

/**
 * Applies whichever of the two changed.
 *
 * Both are applied in one call so the shop is never left half-moved: a phone
 * number proved by OTP and a GSTIN confirmed at the registry either both land
 * or neither does.
 */
const applyProfileChanges = async (session, { editToken, phone, otp, gstNumber }) => {
  requireEditToken(editToken, session);

  const user = await BusinessUser.findById(session.userId);
  if (!user) throw new Error('UNAUTHORIZED');
  const business = await Business.findById(session.businessId);
  if (!business) throw new Error('BUSINESS_NOT_FOUND');

  const nextPhone = phone === undefined ? null : tenDigits(phone);
  const nextGst = gstNumber === undefined ? null : String(gstNumber).trim().toUpperCase();
  const phoneChanged = nextPhone !== null && nextPhone !== tenDigits(user.phone);
  const gstChanged = nextGst !== null && nextGst !== String(business.gstNumber || '').toUpperCase();

  if (!phoneChanged && !gstChanged) throw new Error('NOTHING_TO_CHANGE');

  // The GSTIN is read before anything is written: a registry that refuses it
  // must not leave a new phone number behind.
  let gstDetails = null;
  if (gstChanged) {
    gstDetails = await gstService.verifyGST(nextGst);
    if (gstDetails.isMock) {
      // Stub details would overwrite a real registered name with "Dev Mode
      // Business" and there would be no way back to it.
      throw new Error('GST_VERIFICATION_UNAVAILABLE');
    }
  }

  const previousPhone = tenDigits(user.phone);

  if (phoneChanged) {
    if (!/^[6-9][0-9]{9}$/.test(nextPhone)) throw new Error('INVALID_PHONE_NUMBER');
    const taken = await BusinessUser.findOne({ phone: nextPhone, _id: { $ne: user._id } })
      .select('_id')
      .lean();
    if (taken) throw new Error('PHONE_ALREADY_REGISTERED');
  }

  // Every change is proved with the code, against the number it was sent to:
  // the new number when that is what is changing, the account's own otherwise.
  if (!String(otp || '').trim()) throw new Error('OTP_REQUIRED');
  await otpService.verifyOtpByMobile({
    mobile: phoneChanged ? nextPhone : previousPhone,
    otp: String(otp || ''),
    flow: PHONE_CHANGE_FLOW,
    route: '/api/v1/settings/business-profile',
  });

  if (gstChanged) {
    business.gstNumber = gstDetails.gstNumber || nextGst;
    business.legalName = gstDetails.legalName || business.legalName;
    business.tradeName = gstDetails.tradeName || gstDetails.legalName || business.tradeName;
    business.companyType = gstDetails.companyType || business.companyType;
    business.businessType = gstDetails.businessType || business.businessType;
    business.address = gstDetails.address || business.address;
    business.stateName = gstDetails.stateName || business.stateName;
    business.pincode = gstDetails.pincode || business.pincode;
    await business.save();
  }

  if (phoneChanged) {
    user.phone = nextPhone;
    await user.save();

    // The licence is looked up on the owner's number, so it has to move with
    // them. Without this, support searching the new number finds nothing and
    // the old number still answers with this shop's licence.
    if (user.role === 'OWNER') {
      const licence = await OrganizationLicense.findOne({ businessId: session.businessId });
      if (licence) {
        licence.ownerUserId = user._id;
        licence.ownerPhone = nextPhone;
        await licence.save();
      }
    }
  }

  console.info('[PROFILE_UPDATED]', {
    businessId: String(session.businessId),
    phone: tenDigits(user.phone),
    phoneChangedFrom: phoneChanged ? previousPhone : undefined,
    gstNumber: business.gstNumber || '',
    gstChanged,
  });

  return {
    phoneChanged,
    gstChanged,
    phone: tenDigits(user.phone),
    gstNumber: business.gstNumber || '',
    businessName: business.tradeName || business.legalName || '',
    businessType: business.companyType || business.businessType || '',
    address: business.address || '',
  };
};

module.exports = {
  startProfileEdit,
  sendProfileChangeOtp,
  previewGstChange,
  applyProfileChanges,
};
